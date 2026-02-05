"use client";

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { db } from '@/lib/firebase';
import { doc, getDoc, collection, getDocs, updateDoc, query, where } from 'firebase/firestore';
import { fetchPunctualityLogsByDoctorId, type PunctualityLog } from '@/lib/analytics';
import { firestoreTimestampToDate } from '@/lib/metrics';
import { format } from 'date-fns';
import { Clock, TrendingUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from '@/lib/utils';

export default function DoctorDetailsPage() {
  const params = useParams();
  const id = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const [doctor, setDoctor] = useState<any>(null);
  const [clinicName, setClinicName] = useState<string>('-');
  const [departmentName, setDepartmentName] = useState<string>('-');
  const [loading, setLoading] = useState(true);
  const [punctualityLogs, setPunctualityLogs] = useState<PunctualityLog[]>([]);

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

      // Fetch punctuality logs
      const pLogs = await fetchPunctualityLogsByDoctorId(id);
      setPunctualityLogs(pLogs);

      setLoading(false);
    };
    fetchDoctor();
  }, [id]);

  return (
    <div className="max-w-4xl mx-auto py-10 px-4">
      <Card>
        <CardHeader>
          <CardTitle>Doctor Details</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-10">Loading...</div>
          ) : !doctor ? (
            <div className="text-center py-10 text-muted-foreground">Doctor not found.</div>
          ) : (
            <div className="space-y-8">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-4">
                <div className="flex justify-between border-b pb-2"><strong>Name:</strong> <span>{doctor.name}</span></div>
                <div className="flex justify-between border-b pb-2"><strong>Department:</strong> <span>{departmentName}</span></div>
                <div className="flex justify-between border-b pb-2"><strong>Clinic:</strong> <span>{clinicName}</span></div>
                <div className="flex justify-between border-b pb-2"><strong>Status:</strong> <Badge variant={doctor.consultationStatus === 'In' ? 'default' : 'secondary'}>{doctor.consultationStatus || '-'}</Badge></div>
                <div className="flex justify-between border-b pb-2"><strong>Phone:</strong> <span>{doctor.phone || doctor.mobile || '-'}</span></div>
                <div className="flex justify-between border-b pb-2"><strong>Registration:</strong> <span>{doctor.registrationNumber || '-'}</span></div>
              </div>

              {/* Punctuality Analytics Section */}
              <div className="pt-4 border-t">
                <div className="flex items-center gap-2 mb-6">
                  <Clock className="w-5 h-5 text-primary" />
                  <h3 className="text-lg font-semibold">Overall Punctuality Performance</h3>
                </div>

                {punctualityLogs.length === 0 ? (
                  <div className="text-muted-foreground bg-muted/30 p-4 rounded-lg text-sm text-center">
                    No punctuality data available for this doctor yet.
                  </div>
                ) : (
                  <div className="space-y-8">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      {(() => {
                        const inLogs = punctualityLogs.filter(l => l.type === 'IN' && l.scheduledTime && l.timestamp);
                        const delays = inLogs.map(l => {
                          const actual = firestoreTimestampToDate(l.timestamp);
                          if (!actual) return null;
                          try {
                            const [time, period] = l.scheduledTime!.split(' ');
                            let [hours, minutes] = time.split(':').map(Number);
                            if (period === 'PM' && hours < 12) hours += 12;
                            if (period === 'AM' && hours === 12) hours = 0;
                            const scheduled = new Date(actual);
                            scheduled.setHours(hours, minutes, 0, 0);
                            return Math.round((actual.getTime() - scheduled.getTime()) / 60000);
                          } catch (e) { return null; }
                        }).filter(d => d !== null) as number[];

                        const avgDelay = delays.length > 0 ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : 0;
                        const lateStarts = delays.filter(d => d > 10).length;
                        const extensions = punctualityLogs.filter(l => l.type === 'EXTENSION').length;

                        return (
                          <>
                            <Card className="bg-primary/5 border-none shadow-none">
                              <CardContent className="pt-4">
                                <div className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider font-bold">Avg Delay (Arrival)</div>
                                <div className={cn("text-2xl font-bold", avgDelay > 10 ? "text-red-500" : "text-green-600")}>
                                  {avgDelay > 0 ? `+${avgDelay} min` : `${avgDelay} min`}
                                </div>
                              </CardContent>
                            </Card>
                            <Card className="bg-primary/5 border-none shadow-none">
                              <CardContent className="pt-4">
                                <div className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider font-bold">Late Starts (&gt;10m)</div>
                                <div className="text-2xl font-bold">{lateStarts}</div>
                              </CardContent>
                            </Card>
                            <Card className="bg-primary/5 border-none shadow-none">
                              <CardContent className="pt-4">
                                <div className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider font-bold">Sessions Extended</div>
                                <div className="text-2xl font-bold">{extensions}</div>
                              </CardContent>
                            </Card>
                          </>
                        );
                      })()}
                    </div>

                    <div className="space-y-4">
                      <div className="flex items-center gap-2">
                        <TrendingUp className="w-4 h-4 text-muted-foreground" />
                        <h4 className="text-sm font-semibold">Recent Punctuality Logs</h4>
                      </div>
                      <div className="border rounded-lg overflow-hidden">
                        <Table>
                          <TableHeader className="bg-muted/50">
                            <TableRow>
                              <TableHead className="text-[10px] h-8">Date</TableHead>
                              <TableHead className="text-[10px] h-8">Event</TableHead>
                              <TableHead className="text-[10px] h-8">Scheduled</TableHead>
                              <TableHead className="text-[10px] h-8">Actual</TableHead>
                              <TableHead className="text-[10px] h-8 text-right">Delay</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {punctualityLogs.slice(0, 5).map((log) => {
                              const actualDate = firestoreTimestampToDate(log.timestamp);
                              let delay: number | null = null;
                              if (log.scheduledTime && actualDate) {
                                try {
                                  const [time, period] = log.scheduledTime.split(' ');
                                  let [hours, minutes] = time.split(':').map(Number);
                                  if (period === 'PM' && hours < 12) hours += 12;
                                  if (period === 'AM' && hours === 12) hours = 0;
                                  const scheduled = new Date(actualDate);
                                  scheduled.setHours(hours, minutes, 0, 0);
                                  delay = Math.round((actualDate.getTime() - scheduled.getTime()) / 60000);
                                } catch (e) { }
                              }

                              return (
                                <TableRow key={log.id}>
                                  <TableCell className="py-2 text-[11px]">{log.date}</TableCell>
                                  <TableCell className="py-2">
                                    <Badge variant="outline" className="text-[9px] font-medium uppercase py-0 px-1 border-muted-foreground/30">
                                      {log.type.replace('_', ' ')}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="py-2 text-[11px]">{log.scheduledTime || '-'}</TableCell>
                                  <TableCell className="py-2 text-[11px]">
                                    {actualDate ? format(actualDate, 'hh:mm a') : '-'}
                                  </TableCell>
                                  <TableCell className="py-2 text-[11px] text-right font-bold">
                                    {delay !== null ? (
                                      <span className={delay > 10 ? 'text-red-500' : delay > 0 ? 'text-amber-500' : 'text-green-600'}>
                                        {delay > 0 ? `+${delay}m` : `${delay}m`}
                                      </span>
                                    ) : '-'}
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
