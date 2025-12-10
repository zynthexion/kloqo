
'use client';

import { useState, useEffect, useMemo } from 'react';
import { collection, query, where, getDocs, doc, updateDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useToast } from '@/hooks/use-toast';
import type { Doctor } from '@/lib/types';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '../ui/button';
import EditAvailabilityDialog from './edit-availability-dialog';
import { FirestorePermissionError } from '@kloqo/shared-core';
import { errorEmitter } from '@kloqo/shared-core';
import { cn } from '@/lib/utils';
import { Badge } from '../ui/badge';
import { formatTime12Hour } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';

type TimeSlot = { from: string; to: string };

const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayAbbreviations = ["S", "M", "T", "W", "T", "F", "S"];

export default function AvailabilityManager() {
    const [doctors, setDoctors] = useState<Doctor[]>([]);
    const [selectedDoctor, setSelectedDoctor] = useState<Doctor | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [clinicId, setClinicId] = useState<string | null>(null);
    const { toast } = useToast();

    const [selectedDays, setSelectedDays] = useState<string[]>([]);
    const [isDialogOpen, setIsDialogOpen] = useState(false);

    useEffect(() => {
        const id = localStorage.getItem('clinicId');
        setClinicId(id);
    }, []);

    useEffect(() => {
        if (!clinicId) return;
        const fetchDoctors = async () => {
            setIsLoading(true);
            try {
                const doctorsQuery = query(collection(db, 'doctors'), where('clinicId', '==', clinicId));
                const snapshot = await getDocs(doctorsQuery).catch((e) => {
                    errorEmitter.emit('permission-error', new FirestorePermissionError({ path: 'doctors', operation: 'list' }));
                    throw e;
                });
                const fetchedDoctors = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Doctor));
                setDoctors(fetchedDoctors);
                if (fetchedDoctors.length > 0) {
                    const storedDoctorId = localStorage.getItem('selectedDoctorId');
                    const doctorToSelect = fetchedDoctors.find(d => d.id === storedDoctorId) || fetchedDoctors[0];
                    setSelectedDoctor(doctorToSelect);
                }
            } catch (error) {
                console.error("Error fetching doctors:", error);
                toast({
                    variant: 'destructive',
                    title: 'Error',
                    description: 'Could not fetch doctors list.'
                });
            } finally {
                setIsLoading(false);
            }
        };
        fetchDoctors();
    }, [clinicId, toast]);

    const handleDoctorChange = (doctorId: string) => {
        const doctor = doctors.find(d => d.id === doctorId);
        setSelectedDoctor(doctor || null);
        localStorage.setItem('selectedDoctorId', doctorId);
        setSelectedDays([]);
    };

    const toggleDaySelection = (day: string) => {
        setSelectedDays(prev =>
            prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]
        );
    };

    const updateDoctorAvailability = async (updatedSlots: Doctor['availabilitySlots']) => {
        if (!selectedDoctor) return;

        setIsSubmitting(true);
        try {
            const doctorRef = doc(db, 'doctors', selectedDoctor.id);
            await updateDoc(doctorRef, { availabilitySlots: updatedSlots }).catch((e) => {
                errorEmitter.emit('permission-error', new FirestorePermissionError({ path: doctorRef.path, operation: 'update', requestResourceData: { availabilitySlots: updatedSlots } }));
                throw e;
            });
            setSelectedDoctor(prev => prev ? { ...prev, availabilitySlots: updatedSlots } : null);
            toast({
                title: 'Success',
                description: `Dr. ${selectedDoctor.name}'s availability has been updated.`,
            });
        } catch (error) {
            console.error("Error updating availability:", error);
            toast({
                variant: 'destructive',
                title: 'Update Failed',
                description: 'Could not update doctor availability.'
            })
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleSaveSlot = (days: string[], newSlot: TimeSlot) => {
        if (!selectedDoctor) return;

        let updatedAvailability = [...(selectedDoctor.availabilitySlots || [])];

        days.forEach(day => {
            const existingDayIndex = updatedAvailability.findIndex(s => s.day === day);
            if (existingDayIndex > -1) {
                // Day exists, add new time slot if it doesn't already exist
                const daySlots = updatedAvailability[existingDayIndex].timeSlots;
                if (!daySlots.some(s => s.from === newSlot.from && s.to === newSlot.to)) {
                    const newTimeSlots = [...daySlots, newSlot];
                    newTimeSlots.sort((a, b) => a.from.localeCompare(b.from));
                    updatedAvailability[existingDayIndex] = { ...updatedAvailability[existingDayIndex], timeSlots: newTimeSlots };
                }
            } else {
                // Day doesn't exist, add it with the new slot
                updatedAvailability.push({ day, timeSlots: [newSlot] });
            }
        });

        // Ensure the entire availability array is sorted by day of the week
        updatedAvailability.sort((a, b) => daysOfWeek.indexOf(a.day) - daysOfWeek.indexOf(b.day));

        updateDoctorAvailability(updatedAvailability);
        setIsDialogOpen(false);
        setSelectedDays([]);
    };

    const handleDeleteTimeSlot = (slotToDelete: TimeSlot, daysToDeleteFrom: string[]) => {
        if (!selectedDoctor) return;

        const updatedAvailability = (selectedDoctor.availabilitySlots || []).map(daySlot => {
            if (daysToDeleteFrom.includes(daySlot.day)) {
                return {
                    ...daySlot,
                    timeSlots: daySlot.timeSlots.filter(s => s.from !== slotToDelete.from || s.to !== slotToDelete.to)
                }
            }
            return daySlot;
        }).filter(daySlot => daySlot.timeSlots.length > 0); // Remove days that become empty

        updateDoctorAvailability(updatedAvailability);
    }

    const individualTimeSlots = useMemo(() => {
        if (!selectedDoctor || selectedDays.length === 0) return [];

        let allSlots: ({ from: string; to: string; day: string })[] = [];

        selectedDays.forEach(day => {
            const dayAvailability = selectedDoctor.availabilitySlots?.find(s => s.day === day);
            if (dayAvailability) {
                dayAvailability.timeSlots.forEach(slot => {
                    allSlots.push({ ...slot, day });
                });
            }
        });

        // Group slots by time to display them together
        const slotMap = new Map<string, string[]>(); // Key: "from-to", Value: [days]
        allSlots.forEach(slot => {
            const key = `${slot.from}-${slot.to}`;
            if (!slotMap.has(key)) {
                slotMap.set(key, []);
            }
            slotMap.get(key)!.push(slot.day);
        });

        const slotsArray = Array.from(slotMap.entries()).map(([key, days]) => {
            const [from, to] = key.split('-');
            return { from, to, days };
        });


        return slotsArray.sort((a, b) => a.from.localeCompare(b.from));

    }, [selectedDoctor, selectedDays]);

    if (isLoading) {
        return <div className="flex h-48 items-center justify-center"><Loader2 className="animate-spin" /></div>;
    }

    if (doctors.length === 0) {
        return <div className="flex h-48 items-center justify-center text-center p-4">
            <p className="text-muted-foreground">No doctors found for this clinic. Add doctors to manage their availability.</p>
        </div>;
    }

    return (
        <div className="p-4 space-y-6">
            <div className="space-y-2">
                <label className="text-sm font-medium">Select Doctor</label>
                <Select onValueChange={handleDoctorChange} value={selectedDoctor?.id}>
                    <SelectTrigger>
                        <SelectValue placeholder="Select a doctor" />
                    </SelectTrigger>
                    <SelectContent>
                        {doctors.map(doc => (
                            <SelectItem key={doc.id} value={doc.id}>Dr. {doc.name}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            {selectedDoctor && (
                <div className="space-y-4">
                    <div>
                        <h3 className="font-semibold text-lg mb-2">Select Days to Edit</h3>
                        <div className="flex justify-center gap-1 sm:gap-2 bg-muted p-2 rounded-lg">
                            {daysOfWeek.map((day, index) => (
                                <Button
                                    key={day}
                                    variant={selectedDays.includes(day) ? 'default' : 'outline'}
                                    onClick={() => toggleDaySelection(day)}
                                    className={cn("w-10 h-10 p-0 rounded-full", selectedDays.includes(day) && "bg-primary text-primary-foreground")}
                                >
                                    {dayAbbreviations[index]}
                                </Button>
                            ))}
                        </div>
                    </div>

                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between p-4">
                            <CardTitle className="text-base font-medium">
                                Schedule for {selectedDays.length > 0 ? selectedDays.map(d => d.slice(0, 3)).join(', ') : 'Selected Days'}
                            </CardTitle>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => setIsDialogOpen(true)}
                                disabled={selectedDays.length === 0 || isSubmitting}
                            >
                                <Plus className="h-4 w-4" />
                            </Button>
                        </CardHeader>
                        <CardContent className="p-4 pt-0">
                            {isSubmitting && <Loader2 className="animate-spin" />}
                            {selectedDays.length > 0 && individualTimeSlots.length > 0 ? (
                                <div className="space-y-2">
                                    {individualTimeSlots.map((slot, index) => (
                                        <div key={index} className="flex items-center justify-between p-2 rounded-md bg-muted/50">
                                            <div className='flex-1'>
                                                <Badge variant="secondary" className="text-sm font-mono">
                                                    {formatTime12Hour(slot.from)} - {formatTime12Hour(slot.to)}
                                                </Badge>
                                                <div className="flex flex-wrap gap-1 mt-1.5">
                                                    {slot.days.sort((a, b) => daysOfWeek.indexOf(a) - daysOfWeek.indexOf(b)).map(d => <Badge key={d} variant="outline" className="text-xs">{d.slice(0, 3)}</Badge>)}
                                                </div>
                                            </div>
                                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDeleteTimeSlot(slot, slot.days)}>
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <p className="text-sm text-center text-muted-foreground py-4">
                                    {selectedDays.length > 0 ? "No time slots scheduled. Add one!" : "Select one or more days to see their schedule."}
                                </p>
                            )}
                        </CardContent>
                    </Card>

                    {isDialogOpen && (
                        <EditAvailabilityDialog
                            isOpen={isDialogOpen}
                            onOpenChange={setIsDialogOpen}
                            onSave={handleSaveSlot}
                            days={selectedDays}
                        />
                    )}
                </div>
            )}
        </div>
    );
}


