'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fetchAllClinics, fetchAllAppointments } from '@/lib/analytics';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { calculateClinicHealth } from '@/lib/metrics';
import { firestoreTimestampToDate } from '@/lib/metrics';
import { format } from 'date-fns';
import { Building2, Search, CheckCircle, Clock, XCircle, Check, X, ArrowRight } from 'lucide-react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { Clinic, Appointment } from '@/lib/analytics';

// Simple toast implementation
const showToast = (title: string, description?: string, variant: 'default' | 'destructive' = 'default') => {
  alert(`${title}\n${description || ''}`);
};

export default function ClinicsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'pending' | 'rejected' | 'approved'>('all');
  const [processingAction, setProcessingAction] = useState<string | null>(null);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const [clinicsData, appointmentsData] = await Promise.all([
          fetchAllClinics(),
          fetchAllAppointments(),
        ]);

        // Update currentDoctorCount for each clinic by querying doctors collection
        const clinicsWithUpdatedCounts = await Promise.all(
          clinicsData.map(async (clinic) => {
            try {
              const doctorsQuery = query(collection(db, 'doctors'), where('clinicId', '==', clinic.id));
              const doctorsSnapshot = await getDocs(doctorsQuery);
              const actualDoctorCount = doctorsSnapshot.size;

              // If the stored count doesn't match, update it (but don't update state here, just use for display)
              // We'll use the actual count for display
              return {
                ...clinic,
                currentDoctorCount: actualDoctorCount,
              };
            } catch (error) {
              console.error(`Error fetching doctors for clinic ${clinic.id}:`, error);
              return clinic;
            }
          })
        );

        setClinics(clinicsWithUpdatedCounts);
        setAppointments(appointmentsData);
      } catch (error) {
        console.error('Error loading clinics data:', error);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, []);

  // Filter clinics
  const filteredClinics = clinics.filter((clinic) => {
    const matchesSearch =
      !searchTerm ||
      clinic.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      clinic.city?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      clinic.district?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      clinic.clinicRegNumber?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      clinic.ownerEmail?.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesFilter =
      filterStatus === 'all' ||
      (filterStatus === 'active' && clinic.onboardingStatus === 'Completed' && clinic.registrationStatus === 'Approved') ||
      (filterStatus === 'pending' && clinic.registrationStatus === 'Pending') ||
      (filterStatus === 'approved' && clinic.registrationStatus === 'Approved') ||
      (filterStatus === 'rejected' && clinic.registrationStatus === 'Rejected');

    return matchesSearch && matchesFilter;
  });

  // Calculate clinic stats
  const getClinicStats = (clinic: Clinic) => {
    const clinicAppointments = appointments.filter(apt => apt.clinicId === clinic.id);
    const last30Days = new Date();
    const healthScore = calculateClinicHealth(clinic, clinicAppointments, last30Days);

    return {
      totalAppointments: clinicAppointments.length,
      healthScore,
    };
  };

  const getRegistrationStatusBadge = (status?: string) => {
    switch (status) {
      case 'Approved':
        return <Badge className="bg-green-100 text-green-800 border-green-300"><CheckCircle className="h-3 w-3 mr-1" />Approved</Badge>;
      case 'Pending':
        return <Badge className="bg-yellow-100 text-yellow-800 border-yellow-300"><Clock className="h-3 w-3 mr-1" />Pending</Badge>;
      case 'Rejected':
        return <Badge className="bg-red-100 text-red-800 border-red-300"><XCircle className="h-3 w-3 mr-1" />Rejected</Badge>;
      default:
        return <Badge className="bg-gray-100 text-gray-800 border-gray-300"><Clock className="h-3 w-3 mr-1" />Pending</Badge>;
    }
  };

  const handleApprove = async (e: React.MouseEvent, clinic: Clinic) => {
    e.stopPropagation();
    setProcessingAction(clinic.id);
    try {
      const clinicRef = doc(db, 'clinics', clinic.id);
      await updateDoc(clinicRef, {
        registrationStatus: 'Approved',
      });

      setClinics(prev => prev.map(c =>
        c.id === clinic.id ? { ...c, registrationStatus: 'Approved' } : c
      ));

      showToast('Clinic Approved', `${clinic.name} has been approved and can now login.`);
    } catch (error) {
      console.error('Error approving clinic:', error);
      showToast('Approval Failed', 'Failed to approve clinic. Please try again.', 'destructive');
    } finally {
      setProcessingAction(null);
    }
  };

  const handleReject = async (e: React.MouseEvent, clinic: Clinic) => {
    e.stopPropagation();
    setProcessingAction(clinic.id);
    try {
      const clinicRef = doc(db, 'clinics', clinic.id);
      await updateDoc(clinicRef, {
        registrationStatus: 'Rejected',
      });

      setClinics(prev => prev.map(c =>
        c.id === clinic.id ? { ...c, registrationStatus: 'Rejected' } : c
      ));

      showToast('Clinic Rejected', `${clinic.name} registration has been rejected.`);
    } catch (error) {
      console.error('Error rejecting clinic:', error);
      showToast('Rejection Failed', 'Failed to reject clinic. Please try again.', 'destructive');
    } finally {
      setProcessingAction(null);
    }
  };

  const handleRowClick = (clinicId: string) => {
    router.push(`/dashboard/clinics/${clinicId}`);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto mb-4" />
          <p className="text-muted-foreground">Loading clinics...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Clinic Management</h1>
        <p className="text-muted-foreground mt-1">Monitor and manage all clinics</p>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Clinics</CardDescription>
            <CardTitle className="text-2xl">{clinics.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Pending Approval</CardDescription>
            <CardTitle className="text-2xl text-yellow-600">
              {clinics.filter(c => c.registrationStatus === 'Pending').length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Approved</CardDescription>
            <CardTitle className="text-2xl text-green-600">
              {clinics.filter(c => c.registrationStatus === 'Approved').length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Active</CardDescription>
            <CardTitle className="text-2xl text-blue-600">
              {clinics.filter(c => c.onboardingStatus === 'Completed' && c.registrationStatus === 'Approved').length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Appointments</CardDescription>
            <CardTitle className="text-2xl">{appointments.length}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>All Clinics</CardTitle>
          <CardDescription>Search and filter clinics. Click on a row to view details.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 mb-4">
            <div className="flex-1">
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by name, city, registration number, or email..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-8"
                />
              </div>
            </div>
            <select
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as any)}
            >
              <option value="all">All Status</option>
              <option value="pending">Pending Approval</option>
              <option value="approved">Approved</option>
              <option value="active">Active</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>

          {/* Clinic Table */}
          {filteredClinics.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Building2 className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No clinics found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-3 text-sm font-medium">Clinic Name</th>
                    <th className="text-left p-3 text-sm font-medium">Owner Email</th>
                    <th className="text-left p-3 text-sm font-medium">Location</th>
                    <th className="text-left p-3 text-sm font-medium">Short Code</th>
                    <th className="text-left p-3 text-sm font-medium">Registration #</th>
                    <th className="text-left p-3 text-sm font-medium">Registration Status</th>
                    <th className="text-left p-3 text-sm font-medium">Onboarding Status</th>
                    <th className="text-left p-3 text-sm font-medium">Doctors</th>
                    <th className="text-left p-3 text-sm font-medium">Appointments</th>
                    <th className="text-left p-3 text-sm font-medium">Health Score</th>
                    <th className="text-left p-3 text-sm font-medium">Actions</th>
                    <th className="text-left p-3 text-sm font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredClinics.map((clinic) => {
                    const stats = getClinicStats(clinic);
                    const regDate = clinic.registrationDate ? firestoreTimestampToDate(clinic.registrationDate) : null;

                    return (
                      <tr
                        key={clinic.id}
                        onClick={() => handleRowClick(clinic.id)}
                        className="border-b hover:bg-gray-50 cursor-pointer transition-colors"
                      >
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            {clinic.logoUrl && (
                              <img
                                src={clinic.logoUrl}
                                alt={clinic.name}
                                className="w-8 h-8 object-cover rounded border"
                              />
                            )}
                            <div>
                              <div className="font-medium">{clinic.name}</div>
                              {clinic.type && (
                                <div className="text-xs text-muted-foreground">{clinic.type}</div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="p-3 text-sm">{clinic.ownerEmail || 'N/A'}</td>
                        <td className="p-3 text-sm">
                          <div>
                            {clinic.city || 'N/A'}
                            {clinic.district && <div className="text-xs text-muted-foreground">{clinic.district}</div>}
                          </div>
                        </td>
                        <td className="p-3">
                          {clinic.shortCode ? (
                            <Badge className="bg-blue-50 text-blue-700 border-blue-200 font-mono">
                              {clinic.shortCode}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground italic">Not Set</span>
                          )}
                        </td>
                        <td className="p-3 text-sm">{clinic.clinicRegNumber || 'N/A'}</td>
                        <td className="p-3">
                          {getRegistrationStatusBadge(clinic.registrationStatus)}
                        </td>
                        <td className="p-3">
                          {clinic.onboardingStatus === 'Completed' ? (
                            <Badge className="bg-blue-100 text-blue-800 border-blue-300">
                              <CheckCircle className="h-3 w-3 mr-1" />Completed
                            </Badge>
                          ) : (
                            <Badge className="bg-orange-100 text-orange-800 border-orange-300">
                              <Clock className="h-3 w-3 mr-1" />Pending
                            </Badge>
                          )}
                        </td>
                        <td className="p-3 text-sm">
                          {clinic.currentDoctorCount || 0} / {clinic.numDoctors || 0}
                        </td>
                        <td className="p-3 text-sm font-medium">{stats.totalAppointments}</td>
                        <td className="p-3">
                          <div className={`text-sm font-bold ${stats.healthScore >= 80 ? 'text-green-600' :
                            stats.healthScore >= 60 ? 'text-yellow-600' : 'text-red-600'
                            }`}>
                            {stats.healthScore}
                          </div>
                        </td>
                        <td className="p-3" onClick={(e) => e.stopPropagation()}>
                          {clinic.registrationStatus === 'Pending' && (
                            <div className="flex gap-1">
                              <Button
                                onClick={(e) => handleApprove(e, clinic)}
                                disabled={processingAction === clinic.id}
                                size="sm"
                                className="h-7 px-2 bg-green-600 hover:bg-green-700"
                              >
                                <Check className="h-3 w-3" />
                              </Button>
                              <Button
                                onClick={(e) => handleReject(e, clinic)}
                                disabled={processingAction === clinic.id}
                                variant="destructive"
                                size="sm"
                                className="h-7 px-2"
                              >
                                <X className="h-3 w-3" />
                              </Button>
                            </div>
                          )}
                        </td>
                        <td className="p-3" onClick={(e) => e.stopPropagation()}>
                          <ArrowRight className="h-4 w-4 text-muted-foreground" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
