'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Badge } from '@/components/ui/badge';
import { fetchPunctualityLogs, type PunctualityLog, fetchAllClinics, type Clinic } from '@/lib/analytics';
import { format } from 'date-fns';
import { Clock, AlertTriangle, CheckCircle2, ArrowLeft, TrendingUp, Calendar, User } from 'lucide-react';
import Link from 'next/link';
import { firestoreTimestampToDate } from '@/lib/metrics';

export default function PunctualityReportPage() {
    const [logs, setLogs] = useState<PunctualityLog[]>([]);
    const [clinics, setClinics] = useState<Clinic[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const loadData = async () => {
            setLoading(true);
            try {
                const [logsData, clinicsData] = await Promise.all([
                    fetchPunctualityLogs(),
                    fetchAllClinics()
                ]);
                setLogs(logsData);
                setClinics(clinicsData);
            } catch (error) {
                console.error('Error loading punctuality data:', error);
            } finally {
                setLoading(false);
            }
        };
        loadData();
    }, []);

    const getClinicName = (id: string) => clinics.find(c => c.id === id)?.name || id;

    const calculateDelay = (log: PunctualityLog) => {
        if (!log.scheduledTime || !log.timestamp) return null;
        const actual = firestoreTimestampToDate(log.timestamp);
        if (!actual) return null;

        // Parse scheduled time (e.g., "09:00 AM")
        try {
            const [time, period] = log.scheduledTime.split(' ');
            let [hours, minutes] = time.split(':').map(Number);
            if (period === 'PM' && hours < 12) hours += 12;
            if (period === 'AM' && hours === 12) hours = 0;

            const scheduled = new Date(actual);
            scheduled.setHours(hours, minutes, 0, 0);

            const diff = Math.round((actual.getTime() - scheduled.getTime()) / 60000);
            return diff;
        } catch (e) {
            return null;
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-4">
                <Link href="/dashboard/reports">
                    <Button variant="ghost" size="icon">
                        <ArrowLeft className="h-5 w-5" />
                    </Button>
                </Link>
                <div>
                    <h1 className="text-3xl font-bold">Doctor Punctuality Report</h1>
                    <p className="text-muted-foreground mt-1">Detailed analysis of consultation start/end times and breaks</p>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Card className="bg-blue-50 border-blue-200">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-blue-800 flex items-center gap-2">
                            <TrendingUp className="h-4 w-4" />
                            Recent Logs
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-blue-900">{logs.length}</div>
                        <p className="text-xs text-blue-700">Total timing events recorded</p>
                    </CardContent>
                </Card>

                <Card className="bg-amber-50 border-amber-200">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-amber-800 flex items-center gap-2">
                            <AlertTriangle className="h-4 w-4" />
                            Late Starts
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-amber-900">
                            {logs.filter(l => l.type === 'IN' && (calculateDelay(l) ?? 0) > 10).length}
                        </div>
                        <p className="text-xs text-amber-700">Sessions started {'>'}10 mins late</p>
                    </CardContent>
                </Card>

                <Card className="bg-green-50 border-green-200">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-green-800 flex items-center gap-2">
                            <CheckCircle2 className="h-4 w-4" />
                            Extensions Used
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-green-900">
                            {logs.filter(l => l.type === 'EXTENSION').length}
                        </div>
                        <p className="text-xs text-green-700">Total session extensions granted</p>
                    </CardContent>
                </Card>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Detailed Punctuality Logs</CardTitle>
                    <CardDescription>Real-time tracking of doctor movements</CardDescription>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Timestamp</TableHead>
                                <TableHead>Doctor</TableHead>
                                <TableHead>Clinic</TableHead>
                                <TableHead>Event</TableHead>
                                <TableHead>Scheduled</TableHead>
                                <TableHead>Actual</TableHead>
                                <TableHead>Diff</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {logs.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                                        No punctuality logs found.
                                    </TableCell>
                                </TableRow>
                            ) : (
                                logs.map((log) => {
                                    const delay = calculateDelay(log);
                                    const actualDate = firestoreTimestampToDate(log.timestamp);

                                    return (
                                        <TableRow key={log.id}>
                                            <TableCell className="font-medium">
                                                <div className="flex flex-col">
                                                    <span>{log.date}</span>
                                                    <span className="text-xs text-muted-foreground">
                                                        {actualDate ? format(actualDate, 'HH:mm:ss') : '-'}
                                                    </span>
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <div className="flex items-center gap-2">
                                                    <User className="h-4 w-4 text-muted-foreground" />
                                                    <span>{log.doctorName}</span>
                                                </div>
                                            </TableCell>
                                            <TableCell>{getClinicName(log.clinicId)}</TableCell>
                                            <TableCell>
                                                <Badge variant={
                                                    log.type === 'IN' ? 'default' :
                                                        log.type === 'OUT' ? 'secondary' :
                                                            log.type === 'EXTENSION' ? 'outline' : 'destructive'
                                                }>
                                                    {log.type}
                                                </Badge>
                                            </TableCell>
                                            <TableCell>{log.scheduledTime || '-'}</TableCell>
                                            <TableCell>{actualDate ? format(actualDate, 'hh:mm a') : '-'}</TableCell>
                                            <TableCell>
                                                {delay !== null ? (
                                                    <span className={delay > 10 ? 'text-red-600 font-bold' : delay < -5 ? 'text-green-600' : ''}>
                                                        {delay > 0 ? `+${delay} min` : `${delay} min`}
                                                    </span>
                                                ) : '-'}
                                            </TableCell>
                                        </TableRow>
                                    );
                                })
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
}
