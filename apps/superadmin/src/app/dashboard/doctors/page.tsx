"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { db } from '@/lib/firebase';
import { collection, getDocs } from 'firebase/firestore';

interface Doctor {
  id: string;
  name: string;
  department?: string;
  clinicId?: string;
  status?: string;
}

interface Clinic {
  id: string;
  name: string;
}

export default function DoctorsPage() {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      const [doctorsSnap, clinicsSnap] = await Promise.all([
        getDocs(collection(db, 'doctors')),
        getDocs(collection(db, 'clinics')),
      ]);
      const doctorsList: Doctor[] = doctorsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Doctor));
      const clinicsList: Clinic[] = clinicsSnap.docs.map(doc => ({ id: doc.id, ...(doc.data() as any) }));
      setDoctors(doctorsList);
      setClinics(clinicsList);
      setLoading(false);
    };
    fetchData();
  }, []);

  function getClinicName(clinicId?: string): string {
    if (!clinicId) return '-';
    const clinic = clinics.find(cl => cl.id === clinicId);
    return clinic ? clinic.name : '-';
  }

  return (
    <div className="max-w-5xl mx-auto py-10">
      <Card>
        <CardHeader>
          <CardTitle>Doctors</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Clinic</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={4}>Loading...</TableCell></TableRow>
              ) : doctors.length === 0 ? (
                <TableRow><TableCell colSpan={4}>No doctors found.</TableCell></TableRow>
              ) : (
                doctors.map((doctor) => (
                  <TableRow key={doctor.id} className="cursor-pointer hover:bg-gray-100" onClick={() => router.push(`/dashboard/doctors/${doctor.id}`)}>
                    <TableCell>{doctor.name}</TableCell>
                    <TableCell>{doctor.department || '-'}</TableCell>
                    <TableCell>{getClinicName(doctor.clinicId)}</TableCell>
                    <TableCell>{doctor.status || '-'}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
