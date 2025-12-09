"use client";

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { db } from '@/lib/firebase';
import { doc, getDoc, collection, getDocs, updateDoc, query, where } from 'firebase/firestore';

export default function DoctorDetailsPage() {
  const params = useParams();
  const id = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const [doctor, setDoctor] = useState<any>(null);
  const [clinicName, setClinicName] = useState<string>('-');
  const [departmentName, setDepartmentName] = useState<string>('-');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    const fetchDoctor = async () => {
      setLoading(true);
      // fetch doctor, clinics, and departments
      const doctorSnap = await getDoc(doc(db, 'doctors', id));
      if (!doctorSnap.exists()) {
        setDoctor(null);
        setClinicName('-');
        setDepartmentName('-');
        setLoading(false);
        return;
      }
      const docData = { id, ...doctorSnap.data() };
      setDoctor(docData);
      // fetch all clinics & departments
      const [clinicsSnap, departmentsSnap] = await Promise.all([
        getDocs(collection(db, 'clinics')),
        getDocs(collection(db, 'master-departments')),
      ]);
      const clinics = clinicsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const departments = departmentsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      // get readable clinic name
      const clinic = (clinics as any[]).find(cl => (cl as any).id === (docData as any).clinicId);
      setClinicName(clinic?.name || '-');
      // get readable department name
      let deptName = '-';
      if ((docData as any).department) {
        // department might be an id or a string
        const deptById = (departments as any[]).find((dep: any) => dep.id === (docData as any).department);
        const deptByName = (departments as any[]).find((dep: any) => (dep as any).name === (docData as any).department);
        deptName = (deptById && (deptById as any).name) || (deptByName && (deptByName as any).name) || (docData as any).department || '-';
      }
      setDepartmentName(deptName);
      // Recalculate and update actualAverageConsultationTime
      if ((docData as any).id) {
        // Async IIFE so as not to block render
        (async () => {
          try {
            const appointmentsRef = collection(db, "appointments");
            const q = query(
              appointmentsRef,
              where("doctorId", "==", (docData as any).id),
              where("status", "==", "Completed"),
              where("completedAt", "!=", null),
            );
            const snap = await getDocs(q);
            let completedList = snap.docs
              .map((d) => d.data())
              .filter((apt) => apt.completedAt)
              .sort((a, b) => {
                const aT = a.completedAt?.toDate ? a.completedAt.toDate() : (a.completedAt.seconds ? new Date(a.completedAt.seconds * 1000) : new Date(a.completedAt));
                const bT = b.completedAt?.toDate ? b.completedAt.toDate() : (b.completedAt.seconds ? new Date(b.completedAt.seconds * 1000) : new Date(b.completedAt));
                return aT - bT;
              })
              .slice(-20);
            const times = completedList.map((a) => a.completedAt?.toDate ? a.completedAt.toDate() : (a.completedAt.seconds ? new Date(a.completedAt.seconds * 1000) : new Date(a.completedAt)));
            const gaps = [];
            for (let i = 1; i < times.length; i++) {
              const diff = (times[i] - times[i - 1]) / 1000 / 60;
              if (diff > 2 && diff < 60) gaps.push(diff);
            }
            const avg = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
            if (avg && !isNaN(avg)) {
              await updateDoc(doc(db, "doctors", (docData as any).id), {
                actualAverageConsultationTime: avg,
                actualAverageConsultationTimeUpdatedAt: new Date(),
              });
            }
          } catch (e) {
            // Ignore errors
          }
        })();
      }
      setLoading(false);
    };
    fetchDoctor();
  }, [id]);

  return (
    <div className="max-w-3xl mx-auto py-10">
      <Card>
        <CardHeader>
          <CardTitle>Doctor Details</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div>Loading...</div>
          ) : !doctor ? (
            <div>Doctor not found.</div>
          ) : (
            <div className="space-y-4">
              <div><strong>Name:</strong> {doctor.name}</div>
              <div><strong>Department:</strong> {departmentName}</div>
              <div><strong>Clinic:</strong> {clinicName}</div>
              <div><strong>Status:</strong> {doctor.status || '-'}</div>
              <div><strong>Phone:</strong> {doctor.phone || doctor.mobile || '-'}</div>
              {/* Add more fields as needed here */}
              <hr />
              {/* Placeholder for charts, analytics, etc. */}
              <div>More information will appear here soon.</div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
