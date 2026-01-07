
'use client';

import { useState, useEffect, useMemo } from 'react';
import { format, addDays, subDays, startOfDay, endOfDay, isSameDay, isPast } from 'date-fns';
import {
    BarChart3,
    ChevronLeft,
    ChevronRight,
    Calendar,
    Users,
    CheckCircle2,
    XCircle,
    UserMinus,
    Clock,
    Coffee
} from 'lucide-react';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { Appointment, Doctor } from '@/lib/types';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import ClinicHeader from './header';
import { Carousel, CarouselContent, CarouselItem } from '@/components/ui/carousel';
import { parseTime } from '@/lib/utils';

export default function DaySnapshotView() {
    const [selectedDate, setSelectedDate] = useState(new Date());
    const [appointments, setAppointments] = useState<Appointment[]>([]);
    const [doctors, setDoctors] = useState<Doctor[]>([]);
    const [selectedDoctorId, setSelectedDoctorId] = useState<string>('');
    const [activeSession, setActiveSession] = useState<string>('all');
    const [clinicId, setClinicId] = useState<string | null>(null);
    const [currentMonth, setCurrentMonth] = useState(format(selectedDate, 'MMMM yyyy'));

    // Generate a range of dates (7 days before and 14 days after today)
    const dates = useMemo(() => {
        const today = new Date();
        return Array.from({ length: 22 }, (_, i) => addDays(subDays(today, 7), i));
    }, []);

    useEffect(() => {
        const id = localStorage.getItem('clinicId');
        setClinicId(id);
        const storedDoctorId = localStorage.getItem('selectedDoctorId');
        if (storedDoctorId) setSelectedDoctorId(storedDoctorId);
    }, []);

    // Update current month display when selected date changes
    useEffect(() => {
        setCurrentMonth(format(selectedDate, 'MMMM yyyy'));
    }, [selectedDate]);

    // Fetch doctors for the clinic
    useEffect(() => {
        if (!clinicId) return;
        const q = query(collection(db, 'doctors'), where('clinicId', '==', clinicId));
        const unsubscribe = onSnapshot(q, (snapshot) => {
            const fetchedDoctors = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as Doctor[];
            setDoctors(fetchedDoctors);
            if (!selectedDoctorId && fetchedDoctors.length > 0) {
                setSelectedDoctorId(fetchedDoctors[0].id);
            }
        });
        return () => unsubscribe();
    }, [clinicId, selectedDoctorId]);

    // Fetch appointments for the selected date and doctor
    useEffect(() => {
        if (!clinicId || !selectedDoctorId || !doctors.length) return;
        const currentDoctor = doctors.find(d => d.id === selectedDoctorId);
        if (!currentDoctor) return;

        const dateStr = format(selectedDate, 'd MMMM yyyy');
        const q = query(
            collection(db, 'appointments'),
            where('clinicId', '==', clinicId),
            where('doctor', '==', currentDoctor.name),
            where('date', '==', dateStr)
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const fetched = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as Appointment[];
            setAppointments(fetched);
        });
        return () => unsubscribe();
    }, [clinicId, selectedDoctorId, selectedDate, doctors]);

    const currentDoctor = doctors.find(d => d.id === selectedDoctorId);

    // Get sessions for the selected day
    const sessions = useMemo(() => {
        if (!currentDoctor) return [];
        const dayName = format(selectedDate, 'EEEE');
        const availability = currentDoctor.availabilitySlots?.find(s => s.day === dayName);
        return availability?.timeSlots || [];
    }, [currentDoctor, selectedDate]);

    // Filter appointments by session
    const filteredAppointments = useMemo(() => {
        if (activeSession === 'all') return appointments;
        const sessionIndex = parseInt(activeSession);
        return appointments.filter(a => a.sessionIndex === sessionIndex);
    }, [appointments, activeSession]);

    const isPastDate = isPast(endOfDay(selectedDate)) && !isSameDay(selectedDate, new Date());

    // Stats calculation
    const stats = useMemo(() => {
        const total = filteredAppointments.length;
        const pending = filteredAppointments.filter(a => a.status === 'Pending').length;
        const confirmed = filteredAppointments.filter(a => a.status === 'Confirmed').length;
        const completed = filteredAppointments.filter(a => a.status === 'Completed').length;
        const cancelled = filteredAppointments.filter(a => a.status === 'Cancelled').length;
        const noshow = filteredAppointments.filter(a => a.status === 'No-show').length;
        const skipped = filteredAppointments.filter(a => a.status === 'Skipped').length;

        return { total, pending, confirmed, completed, cancelled, noshow, skipped };
    }, [filteredAppointments]);

    // Estimated Finishing Time calculation
    const estimatedFinishTime = useMemo(() => {
        if (!currentDoctor) return null;

        const avgTime = currentDoctor.averageConsultingTime || 15;
        const remainingCount = stats.confirmed + stats.pending + stats.skipped;

        if (remainingCount === 0) return null;

        const totalMinutes = remainingCount * avgTime;

        let startTime = new Date(); // Default to today

        if (isSameDay(selectedDate, new Date())) {
            // If it's today, we add to current time
            startTime = new Date();
        } else if (isPastDate) {
            return null; // Don't show for past dates
        } else {
            // For future dates, add to the first session start time of the selected session or day
            if (activeSession !== 'all') {
                const sessionIndex = parseInt(activeSession);
                const session = sessions[sessionIndex];
                if (session) {
                    const sessionStart = parseTime(session.from, selectedDate);
                    startTime = sessionStart;
                }
            } else if (sessions.length > 0) {
                const sessionStart = parseTime(sessions[0].from, selectedDate);
                startTime = sessionStart;
            }
        }

        return addMinutes(startTime, totalMinutes);
    }, [currentDoctor, stats, selectedDate, activeSession, sessions, isPastDate]);

    // Break information
    const breaks = useMemo(() => {
        if (!currentDoctor || !currentDoctor.breakPeriods) return [];
        const dateKey = format(selectedDate, 'd MMMM yyyy');
        return currentDoctor.breakPeriods[dateKey] || [];
    }, [currentDoctor, selectedDate]);


    return (
        <div className="flex flex-col h-full bg-slate-50 overflow-hidden">
            <ClinicHeader
                doctors={doctors}
                selectedDoctor={selectedDoctorId}
                onDoctorChange={setSelectedDoctorId}
                showLogo={false}
                pageTitle="Day Snapshot"
                showSettings={false}
            />

            <main className="flex-1 p-4 -mt-6 z-10 bg-white rounded-t-3xl shadow-xl flex flex-col gap-6 overflow-hidden">
                {/* Date Selector Carousel */}
                <div>
                    <div className="flex justify-between items-center mb-4 px-2">
                        <h2 className="font-black text-lg text-slate-800 uppercase tracking-tight">Select Date</h2>
                        <span className="text-sm font-bold text-blue-600 bg-blue-50 px-3 py-1 rounded-full">{currentMonth}</span>
                    </div>

                    <Carousel opts={{ align: "start", dragFree: true }} className="w-full">
                        <CarouselContent className="-ml-2">
                            {dates.map((d, index) => {
                                const isSelected = isSameDay(d, selectedDate);
                                const isToday = isSameDay(d, new Date());
                                return (
                                    <CarouselItem key={index} className="basis-1/5 pl-2">
                                        <div className="p-1">
                                            <button
                                                onClick={() => setSelectedDate(d)}
                                                className={cn(
                                                    "w-full h-auto flex flex-col items-center justify-center p-3 rounded-2xl gap-1 transition-all duration-300 border-2",
                                                    isSelected
                                                        ? "bg-blue-600 text-white border-blue-600 shadow-lg shadow-blue-200 scale-105"
                                                        : "bg-slate-50 border-slate-100 text-slate-600 hover:bg-slate-100 hover:border-slate-200",
                                                    isToday && !isSelected && "border-blue-200"
                                                )}
                                            >
                                                <span className={cn("text-[10px] font-bold uppercase", isSelected ? "text-blue-100" : "text-slate-400")}>
                                                    {format(d, 'EEE')}
                                                </span>
                                                <span className="text-lg font-black tracking-tighter">
                                                    {format(d, 'dd')}
                                                </span>
                                                {isToday && (
                                                    <div className={cn("w-1 h-1 rounded-full translate-y-1", isSelected ? "bg-white" : "bg-blue-600")} />
                                                )}
                                            </button>
                                        </div>
                                    </CarouselItem>
                                )
                            })}
                        </CarouselContent>
                    </Carousel>
                </div>

                <div className="flex-1 overflow-y-auto pr-1 space-y-8 scrollbar-hide">
                    {/* Session Tabs */}
                    {sessions.length > 0 && (
                        <div className="px-2">
                            <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-4">Filter by Session</h3>
                            <Tabs value={activeSession} onValueChange={setActiveSession} className="w-full">
                                <TabsList className="bg-slate-100/50 h-auto p-1.5 w-full grid grid-cols-2 lg:grid-cols-4 gap-2 border border-slate-100 rounded-2xl">
                                    <TabsTrigger
                                        value="all"
                                        className="rounded-xl py-2.5 font-bold data-[state=active]:bg-white data-[state=active]:text-blue-600 data-[state=active]:shadow-sm transition-all"
                                    >
                                        All Day
                                    </TabsTrigger>
                                    {sessions.map((session, index) => (
                                        <TabsTrigger
                                            key={index}
                                            value={index.toString()}
                                            className="rounded-xl py-2.5 font-bold data-[state=active]:bg-white data-[state=active]:text-blue-600 data-[state=active]:shadow-sm transition-all text-xs"
                                        >
                                            {session.from} - {session.to}
                                        </TabsTrigger>
                                    ))}
                                </TabsList>
                            </Tabs>
                        </div>
                    )}

                    {/* Stats Grid */}
                    <div className="grid grid-cols-2 gap-4">
                        <Card className="border-none shadow-sm bg-blue-50/50 rounded-2xl overflow-hidden ring-1 ring-blue-100/50">
                            <CardContent className="p-4 flex flex-col items-center justify-center">
                                <div className="bg-blue-100 p-2.5 rounded-2xl mb-3 shadow-sm shadow-blue-100">
                                    <Users className="h-5 w-5 text-blue-600" />
                                </div>
                                <p className="text-3xl font-black text-blue-700 tracking-tighter">{stats.total}</p>
                                <p className="text-[10px] uppercase font-black text-blue-400 tracking-wider mt-1">Total Bookings</p>
                            </CardContent>
                        </Card>

                        <Card className="border-none shadow-sm bg-amber-50/50 rounded-2xl overflow-hidden ring-1 ring-amber-100/50">
                            <CardContent className="p-4 flex flex-col items-center justify-center">
                                <div className="bg-amber-100 p-2.5 rounded-2xl mb-3 shadow-sm shadow-amber-100">
                                    <Clock className="h-5 w-5 text-amber-600" />
                                </div>
                                <p className="text-3xl font-black text-amber-700 tracking-tighter">{stats.confirmed}</p>
                                <p className="text-[10px] uppercase font-black text-amber-400 tracking-wider mt-1">Waiting in Clinic</p>
                            </CardContent>
                        </Card>

                        {isPastDate || stats.completed > 0 ? (
                            <Card className="border-none shadow-sm bg-green-50/50 rounded-2xl overflow-hidden ring-1 ring-green-100/50">
                                <CardContent className="p-4 flex flex-col items-center justify-center">
                                    <div className="bg-green-100 p-2.5 rounded-2xl mb-3 shadow-sm shadow-green-100">
                                        <CheckCircle2 className="h-5 w-5 text-green-600" />
                                    </div>
                                    <p className="text-3xl font-black text-green-700 tracking-tighter">{stats.completed}</p>
                                    <p className="text-[10px] uppercase font-black text-green-400 tracking-wider mt-1">Completed</p>
                                </CardContent>
                            </Card>
                        ) : (
                            <Card className="border-none shadow-sm bg-slate-50/50 rounded-2xl overflow-hidden ring-1 ring-slate-100/50">
                                <CardContent className="p-4 flex flex-col items-center justify-center">
                                    <div className="bg-slate-100 p-2.5 rounded-2xl mb-3 shadow-sm shadow-slate-100">
                                        <UserMinus className="h-5 w-5 text-slate-600" />
                                    </div>
                                    <p className="text-3xl font-black text-slate-700 tracking-tighter">{stats.pending}</p>
                                    <p className="text-[10px] uppercase font-black text-slate-400 tracking-wider mt-1">Not Arrived</p>
                                </CardContent>
                            </Card>
                        )}

                        {isPastDate && (
                            <Card className="border-none shadow-sm bg-red-50/50 rounded-2xl overflow-hidden ring-1 ring-red-100/50">
                                <CardContent className="p-4 flex flex-col items-center justify-center">
                                    <div className="bg-red-100 p-2.5 rounded-2xl mb-3 shadow-sm shadow-red-100">
                                        <XCircle className="h-5 w-5 text-red-600" />
                                    </div>
                                    <p className="text-3xl font-black text-red-700 tracking-tighter">{stats.cancelled + stats.noshow}</p>
                                    <p className="text-[10px] uppercase font-black text-red-400 tracking-wider mt-1">Missed/Cancelled</p>
                                </CardContent>
                            </Card>
                        )}
                    </div>

                    {/* Estimated Finish Time Banner */}
                    {estimatedFinishTime && !isPastDate && (
                        <div className="bg-gradient-to-br from-indigo-500 to-purple-600 rounded-3xl p-6 text-white shadow-xl shadow-indigo-100 relative overflow-hidden group">
                            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:scale-110 transition-transform duration-500">
                                <Clock className="h-24 w-24" />
                            </div>
                            <div className="relative z-10">
                                <div className="flex items-center gap-2 mb-2">
                                    <span className="bg-white/20 px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest whitespace-nowrap">
                                        {isSameDay(selectedDate, new Date()) ? 'Real-time Estimate' : 'Expected Duration'}
                                    </span>
                                </div>
                                <h3 className="text-sm font-bold opacity-80 mb-1">Estimated Completion</h3>
                                <div className="flex items-baseline gap-2">
                                    <p className="text-4xl font-black tracking-tighter">
                                        {format(estimatedFinishTime, 'hh:mm a')}
                                    </p>
                                </div>
                                <p className="text-xs opacity-70 mt-2 font-medium">
                                    Based on {stats.confirmed + stats.pending + stats.skipped} waiting patients • {currentDoctor?.averageConsultingTime || 15}m per visit
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Detailed Past Stats */}
                    {isPastDate && (
                        <div className="bg-slate-50 rounded-2xl p-4 mb-8">
                            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">Past Performance</h3>
                            <div className="flex justify-between items-center text-sm font-bold">
                                <div className="flex items-center gap-2">
                                    <div className="w-2 h-2 rounded-full bg-red-500" />
                                    <span className="text-slate-600">Cancelled</span>
                                </div>
                                <span className="text-red-600">{stats.cancelled}</span>
                            </div>
                            <div className="flex justify-between items-center text-sm font-bold mt-2">
                                <div className="flex items-center gap-2">
                                    <div className="w-2 h-2 rounded-full bg-amber-500" />
                                    <span className="text-slate-600">No-show</span>
                                </div>
                                <span className="text-amber-600">{stats.noshow}</span>
                            </div>
                        </div>
                    )}

                    {/* Break Information */}
                    <div className="space-y-4">
                        <div className="flex items-center gap-2">
                            <Coffee className="h-5 w-5 text-amber-600" />
                            <h3 className="font-black text-slate-800 uppercase tracking-tight">Break Schedule</h3>
                        </div>
                        {breaks.length > 0 ? (
                            breaks.map((brk, i) => (
                                <div key={i} className="flex items-center justify-between p-4 bg-amber-50 rounded-2xl border border-amber-100">
                                    <div className="flex items-center gap-3">
                                        <Clock className="h-4 w-4 text-amber-600" />
                                        <span className="font-bold text-amber-800">
                                            {format(new Date(brk.startTime), 'hh:mm a')} - {format(new Date(brk.endTime), 'hh:mm a')}
                                        </span>
                                    </div>
                                    <Badge className="bg-amber-200 text-amber-800 hover:bg-amber-200 border-none px-3 py-1 font-bold text-[10px] uppercase">
                                        Scheduled
                                    </Badge>
                                </div>
                            ))
                        ) : (
                            <div className="p-8 text-center bg-slate-50 rounded-2xl border border-dashed border-slate-200">
                                <p className="text-sm font-bold text-slate-400 italic">No breaks scheduled for this day</p>
                            </div>
                        )}
                    </div>
                </div>
            </main>
        </div>
    );
}
