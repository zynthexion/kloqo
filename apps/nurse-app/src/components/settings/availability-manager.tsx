
'use client';

import React, { useState, useEffect, useMemo, useTransition } from 'react';
import { collection, query, where, getDocs, doc, updateDoc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useToast } from '@/hooks/use-toast';
import type { Doctor, TimeSlot } from '@/lib/types';
import { Loader2, Trash2, Plus, Info, Edit, Save, X, Trash, Clock } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '../ui/button';
import { FirestorePermissionError } from '@kloqo/shared-core';
import { errorEmitter } from '@kloqo/shared-core';
import { cn } from '@/lib/utils';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card';
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { format, parse, isBefore, addMinutes } from 'date-fns';
import { Form } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayAbbreviations = ["S", "M", "T", "W", "T", "F", "S"];

const timeSlotSchema = z.object({
    from: z.string().min(1, "Required"),
    to: z.string().min(1, "Required"),
}).refine(data => {
    if (!data.from || !data.to) return true;
    return data.from < data.to;
}, {
    message: "End time must be after start time.",
    path: ["to"],
});

const availabilitySlotSchema = z.object({
    day: z.string(),
    timeSlots: z.array(timeSlotSchema).min(1, "At least one time slot is required."),
}).refine(data => {
    const sortedSlots = [...data.timeSlots].sort((a, b) => a.from.localeCompare(b.from));
    for (let i = 0; i < sortedSlots.length - 1; i++) {
        if (sortedSlots[i].to > sortedSlots[i + 1].from) {
            return false;
        }
    }
    return true;
}, {
    message: "Time slots cannot overlap.",
    path: ["timeSlots"],
});

const weeklyAvailabilityFormSchema = z.object({
    availabilitySlots: z.array(availabilitySlotSchema).min(1, "At least one availability slot is required."),
});

type WeeklyAvailabilityFormValues = z.infer<typeof weeklyAvailabilityFormSchema>;

const generateTimeOptions = (startTime: string, endTime: string, interval: number): string[] => {
    const options = [];
    let currentTime = parse(startTime, "HH:mm", new Date());
    const end = parse(endTime, "HH:mm", new Date());

    while (isBefore(currentTime, end)) {
        options.push(format(currentTime, "HH:mm"));
        currentTime = addMinutes(currentTime, interval);
    }
    options.push(format(end, "HH:mm"));
    return options;
};

export default function AvailabilityManager() {
    const [doctors, setDoctors] = useState<Doctor[]>([]);
    const [selectedDoctor, setSelectedDoctor] = useState<Doctor | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isPending, startTransition] = useTransition();
    const [clinicId, setClinicId] = useState<string | null>(null);
    const [clinicDetails, setClinicDetails] = useState<any | null>(null);
    const { toast } = useToast();

    const [isEditingAvailability, setIsEditingAvailability] = useState(false);
    const [selectedDays, setSelectedDays] = useState<string[]>([]);
    const [sharedTimeSlots, setSharedTimeSlots] = useState<Array<{ from: string; to: string }>>([{ from: "09:00", to: "17:00" }]);

    const form = useForm<WeeklyAvailabilityFormValues>({
        resolver: zodResolver(weeklyAvailabilityFormSchema),
        defaultValues: {
            availabilitySlots: [],
        },
        mode: "onBlur",
    });

    useEffect(() => {
        const id = localStorage.getItem('clinicId');
        setClinicId(id);
    }, []);

    useEffect(() => {
        if (!clinicId) return;
        const fetchData = async () => {
            setIsLoading(true);
            try {
                const clinicDocSnap = await getDoc(doc(db, "clinics", clinicId));
                if (clinicDocSnap.exists()) {
                    setClinicDetails(clinicDocSnap.data());
                }

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
                console.error("Error fetching data:", error);
                toast({
                    variant: 'destructive',
                    title: 'Error',
                    description: 'Could not fetch data.'
                });
            } finally {
                setIsLoading(false);
            }
        };
        fetchData();
    }, [clinicId, toast]);

    useEffect(() => {
        if (selectedDoctor) {
            form.reset({
                availabilitySlots: selectedDoctor.availabilitySlots || [],
            });
            setIsEditingAvailability(false);
            setSelectedDays([]);
        }
    }, [selectedDoctor, form]);

    const handleDoctorChange = (doctorId: string) => {
        const doctor = doctors.find(d => d.id === doctorId);
        setSelectedDoctor(doctor || null);
        localStorage.setItem('selectedDoctorId', doctorId);
    };

    const handleEditAvailability = () => {
        if (!selectedDoctor) return;

        const availabilitySlotsForForm = selectedDoctor.availabilitySlots?.map(s => {
            return {
                ...s,
                timeSlots: s.timeSlots.map(ts => {
                    try {
                        const parsedFrom = parse(ts.from, 'hh:mm a', new Date());
                        const parsedTo = parse(ts.to, 'hh:mm a', new Date());
                        return {
                            from: !isNaN(parsedFrom.valueOf()) ? format(parsedFrom, 'HH:mm') : ts.from,
                            to: !isNaN(parsedTo.valueOf()) ? format(parsedTo, 'HH:mm') : ts.to
                        }
                    } catch {
                        return { from: ts.from, to: ts.to };
                    }
                })
            };
        }) || [];

        form.reset({
            availabilitySlots: availabilitySlotsForForm,
        });
        setIsEditingAvailability(true);
    };

    const handleAvailabilitySave = (values: WeeklyAvailabilityFormValues) => {
        if (!selectedDoctor) return;

        const validSlots = values.availabilitySlots
            .map(slot => {
                const filteredTimeSlots = slot.timeSlots.filter(ts => ts.from && ts.to);
                return { ...slot, timeSlots: filteredTimeSlots };
            })
            .filter(slot => slot.timeSlots.length > 0);

        const newAvailabilitySlots = validSlots.map(s => ({
            ...s,
            timeSlots: s.timeSlots.map(ts => ({
                from: format(parse(ts.from, "HH:mm", new Date()), "hh:mm a"),
                to: format(parse(ts.to, "HH:mm", new Date()), "hh:mm a")
            }))
        }));

        const scheduleString = newAvailabilitySlots
            ?.sort((a, b) => daysOfWeek.indexOf(a.day) - daysOfWeek.indexOf(b.day))
            .map(slot => `${slot.day}: ${slot.timeSlots.map(ts => `${ts.from}-${ts.to}`).join(', ')}`)
            .join('; ');

        startTransition(async () => {
            const doctorRef = doc(db, "doctors", selectedDoctor.id);
            try {
                await updateDoc(doctorRef, {
                    availabilitySlots: newAvailabilitySlots,
                    schedule: scheduleString,
                });

                const updatedDoctor = { ...selectedDoctor, availabilitySlots: newAvailabilitySlots, schedule: scheduleString };
                setSelectedDoctor(updatedDoctor);
                setDoctors(prev => prev.map(d => d.id === selectedDoctor.id ? updatedDoctor : d));
                setIsEditingAvailability(false);
                toast({
                    title: "Availability Updated",
                    description: "Weekly availability has been successfully updated.",
                });
            } catch (error) {
                console.error("Error updating availability:", error);
                toast({
                    variant: "destructive",
                    title: "Update Failed",
                    description: "Could not update weekly availability.",
                });
            }
        });
    };

    const handleDeleteTimeSlot = async (day: string, timeSlot: TimeSlot) => {
        if (!selectedDoctor) return;

        const updatedAvailabilitySlots = selectedDoctor.availabilitySlots?.map(slot => {
            if (slot.day === day) {
                const updatedTimeSlots = slot.timeSlots.filter(ts => ts.from !== timeSlot.from || ts.to !== timeSlot.to);
                return { ...slot, timeSlots: updatedTimeSlots };
            }
            return slot;
        }).filter(slot => slot.timeSlots.length > 0);

        startTransition(async () => {
            const doctorRef = doc(db, "doctors", selectedDoctor.id);
            try {
                await updateDoc(doctorRef, {
                    availabilitySlots: updatedAvailabilitySlots,
                });
                const updatedDoctor = { ...selectedDoctor, availabilitySlots: updatedAvailabilitySlots };
                setSelectedDoctor(updatedDoctor);
                setDoctors(prev => prev.map(d => d.id === selectedDoctor.id ? updatedDoctor : d));
                toast({
                    title: "Time Slot Deleted",
                    description: `The time slot has been removed from ${day}.`,
                });
            } catch (error) {
                console.error("Error deleting time slot:", error);
                toast({
                    variant: "destructive",
                    title: "Update Failed",
                    description: "Could not delete the time slot.",
                });
            }
        });
    };

    const applySharedSlotsToSelectedDays = () => {
        if (selectedDays.length === 0) {
            toast({
                variant: "destructive",
                title: "No days selected",
                description: "Please select one or more days to apply the time slots.",
            });
            return;
        }

        const validSharedTimeSlots = sharedTimeSlots.filter(ts => ts.from && ts.to);

        if (validSharedTimeSlots.length === 0) {
            toast({
                variant: "destructive",
                title: "No time slots defined",
                description: "Please define at least one valid time slot.",
            });
            return;
        }

        for (const day of selectedDays) {
            const clinicDay = clinicDetails?.operatingHours?.find((h: any) => h.day === day);
            if (!clinicDay || clinicDay.isClosed) {
                toast({ variant: "destructive", title: "Invalid Day", description: `Clinic is closed on ${day}.` });
                return;
            }

            const clinicOpeningTime = clinicDay.timeSlots[0]?.open || "00:00";
            const clinicClosingTime = clinicDay.timeSlots[clinicDay.timeSlots.length - 1]?.close || "23:45";

            for (const slot of validSharedTimeSlots) {
                if (slot.from < clinicOpeningTime || slot.to > clinicClosingTime) {
                    toast({
                        variant: "destructive",
                        title: "Outside Clinic Hours",
                        description: `Some slots on ${day} are outside clinic operating hours (${format(parse(clinicOpeningTime, 'HH:mm', new Date()), 'p')} - ${format(parse(clinicClosingTime, 'HH:mm', new Date()), 'p')}).`
                    });
                    return;
                }
            }
        }

        const currentSlots = form.getValues('availabilitySlots') || [];
        const updatedSlots = [...currentSlots];

        for (const day of selectedDays) {
            const existingIndex = updatedSlots.findIndex(s => s.day === day);
            if (existingIndex >= 0) {
                updatedSlots[existingIndex] = { day, timeSlots: JSON.parse(JSON.stringify(validSharedTimeSlots)) };
            } else {
                updatedSlots.push({ day, timeSlots: JSON.parse(JSON.stringify(validSharedTimeSlots)) });
            }
        }

        form.setValue('availabilitySlots', updatedSlots, { shouldDirty: true, shouldValidate: true });
        toast({
            title: "Slots Applied",
            description: `Configured slots applied to ${selectedDays.length} days. Review and save below.`,
        });
    };

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
                <div className="space-y-6">
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between">
                            <div className="space-y-1.5">
                                <CardTitle className="flex items-center gap-2"><Clock className="w-5 h-5" /> Schedule</CardTitle>
                                <CardDescription>Recurring weekly schedule.</CardDescription>
                            </div>
                            {!isEditingAvailability && (
                                <Button variant="outline" size="sm" onClick={handleEditAvailability}>
                                    <Edit className="mr-2 h-4 w-4" /> Edit
                                </Button>
                            )}
                        </CardHeader>
                        <CardContent>
                            {isEditingAvailability ? (
                                <Form {...form}>
                                    <form onSubmit={form.handleSubmit(handleAvailabilitySave)} className="space-y-4">
                                        <div className="space-y-2">
                                            <Label>1. Select days to apply time slots to</Label>
                                            <ToggleGroup type="multiple" value={selectedDays} onValueChange={setSelectedDays} variant="outline" className="flex-wrap justify-start">
                                                {daysOfWeek.map((day, index) => {
                                                    const clinicDay = clinicDetails?.operatingHours?.find((h: any) => h.day === day);
                                                    const isDisabled = !clinicDay || clinicDay.isClosed;
                                                    return (
                                                        <ToggleGroupItem key={daysOfWeek[index]} value={daysOfWeek[index]} aria-label={`Toggle ${daysOfWeek[index]}`} className="h-9 w-9" disabled={isDisabled}>
                                                            {dayAbbreviations[index]}
                                                        </ToggleGroupItem>
                                                    )
                                                })}
                                            </ToggleGroup>
                                        </div>

                                        <div className="space-y-2">
                                            <Label>2. Define time slots</Label>
                                            {sharedTimeSlots.map((ts, index) => {
                                                const dayForSlot = selectedDays[0] || daysOfWeek.find(day => !clinicDetails?.operatingHours?.find((h: any) => h.day === day)?.isClosed);
                                                const clinicDay = clinicDetails?.operatingHours?.find((h: any) => h.day === dayForSlot);
                                                if (!clinicDay) return null;

                                                const clinicOpeningTime = clinicDay.timeSlots[0]?.open || "00:00";
                                                const clinicClosingTime = clinicDay.timeSlots[clinicDay.timeSlots.length - 1]?.close || "23:45";
                                                const allTimeOptions = generateTimeOptions(clinicOpeningTime, clinicClosingTime, 15);

                                                const fromTimeOptions = allTimeOptions.filter(time =>
                                                    !sharedTimeSlots.filter((_, i) => i !== index).some(slot => time >= slot.from && time < slot.to)
                                                ).slice(0, -1);

                                                const nextSlotStart = [...sharedTimeSlots]
                                                    .filter(slot => slot.from > ts.from)
                                                    .sort((a, b) => a.from.localeCompare(b.from))[0]?.from || clinicClosingTime;

                                                const toTimeOptions = ts.from
                                                    ? allTimeOptions.filter(t => t > ts.from && t <= nextSlotStart)
                                                    : [];

                                                return (
                                                    <div key={index} className="flex items-end gap-2">
                                                        <div className="flex-grow space-y-1">
                                                            <Label className="text-xs font-normal">From</Label>
                                                            <Select
                                                                value={ts.from}
                                                                onValueChange={(value) => {
                                                                    const newShared = [...sharedTimeSlots];
                                                                    newShared[index].from = value;
                                                                    if (newShared[index].to <= value) {
                                                                        newShared[index].to = '';
                                                                    }
                                                                    setSharedTimeSlots(newShared);
                                                                }}
                                                            >
                                                                <SelectTrigger><SelectValue placeholder="Start" /></SelectTrigger>
                                                                <SelectContent>
                                                                    {fromTimeOptions.map(time => (
                                                                        <SelectItem key={`from-${time}`} value={time}>{format(parse(time, "HH:mm", new Date()), 'p')}</SelectItem>
                                                                    ))}
                                                                </SelectContent>
                                                            </Select>
                                                        </div>
                                                        <div className="flex-grow space-y-1">
                                                            <Label className="text-xs font-normal">To</Label>
                                                            <Select
                                                                value={ts.to}
                                                                onValueChange={(value) => {
                                                                    const newShared = [...sharedTimeSlots];
                                                                    newShared[index].to = value;
                                                                    setSharedTimeSlots(newShared);
                                                                }}
                                                                disabled={!ts.from}
                                                            >
                                                                <SelectTrigger><SelectValue placeholder="End" /></SelectTrigger>
                                                                <SelectContent>
                                                                    {toTimeOptions.map(time => (
                                                                        <SelectItem key={`to-${time}`} value={time}>{format(parse(time, "HH:mm", new Date()), 'p')}</SelectItem>
                                                                    ))}
                                                                </SelectContent>
                                                            </Select>
                                                        </div>
                                                        <Button type="button" variant="ghost" size="icon" onClick={() => setSharedTimeSlots(prev => prev.filter((_, i) => i !== index))} disabled={sharedTimeSlots.length <= 1}>
                                                            <Trash className="h-4 w-4 text-red-500" />
                                                        </Button>
                                                    </div>
                                                )
                                            })}
                                            <Button type="button" size="sm" variant="outline" onClick={() => setSharedTimeSlots(prev => [...prev, { from: "", to: "" }])}>
                                                Add Another Slot
                                            </Button>
                                        </div>

                                        <Button type="button" className="w-full" onClick={applySharedSlotsToSelectedDays}>
                                            3. Apply to Selected Days
                                        </Button>

                                        <div className="space-y-2 pt-4">
                                            <Label>Review and save</Label>
                                            <div className="space-y-3 rounded-md border p-3 max-h-48 overflow-y-auto">
                                                {form.watch('availabilitySlots') && form.watch('availabilitySlots').length > 0 ? (
                                                    [...form.watch('availabilitySlots')]
                                                        .sort((a, b) => daysOfWeek.indexOf(a.day) - daysOfWeek.indexOf(b.day))
                                                        .map((fieldItem, index) => (
                                                            <div key={index} className="text-sm">
                                                                <p className="font-semibold">{fieldItem.day}</p>
                                                                <div className="flex flex-wrap gap-1 mt-1">
                                                                    {fieldItem.timeSlots.map((ts, i) => {
                                                                        if (!ts.from || !ts.to) return null;
                                                                        return (
                                                                            <Badge key={i} variant="secondary" className="font-normal">
                                                                                {format(parse(ts.from, "HH:mm", new Date()), 'p')} - {format(parse(ts.to, "HH:mm", new Date()), 'p')}
                                                                            </Badge>
                                                                        );
                                                                    })}
                                                                </div>
                                                            </div>
                                                        ))
                                                ) : <p className="text-xs text-muted-foreground text-center pt-6">No availability applied yet.</p>
                                                }
                                            </div>
                                        </div>

                                        <div className="flex justify-end gap-2 mt-4">
                                            <Button type="button" variant="ghost" onClick={() => setIsEditingAvailability(false)} disabled={isPending}>Cancel</Button>
                                            <Button type="submit" disabled={isPending || !form.formState.isValid}>
                                                {isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving...</> : 'Save Schedule'}
                                            </Button>
                                        </div>
                                    </form>
                                </Form>
                            ) : (
                                <div className="space-y-4">
                                    {selectedDoctor.availabilitySlots && selectedDoctor.availabilitySlots.length > 0 ? (
                                        selectedDoctor.availabilitySlots
                                            .slice()
                                            .sort((a, b) => daysOfWeek.indexOf(a.day) - daysOfWeek.indexOf(b.day))
                                            .map((slot, index) => (
                                                <React.Fragment key={index}>
                                                    <div>
                                                        <p className="font-semibold text-sm">{slot.day}</p>
                                                        <div className="flex flex-wrap gap-2 items-center mt-2">
                                                            {slot.timeSlots.map((ts, i) => {
                                                                if (!ts.from || !ts.to) return null;
                                                                const fromTime = parse(ts.from, 'hh:mm a', new Date());
                                                                const toTime = parse(ts.to, 'hh:mm a', new Date());

                                                                return (
                                                                    <Badge key={i} variant="outline" className="text-sm group relative pr-7">
                                                                        {!isNaN(fromTime.valueOf()) ? format(fromTime, 'p') : ts.from} - {!isNaN(toTime.valueOf()) ? format(toTime, 'p') : ts.to}
                                                                        <button
                                                                            onClick={() => handleDeleteTimeSlot(slot.day, ts)}
                                                                            className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity"
                                                                        >
                                                                            <X className="h-3 w-3 text-red-500" />
                                                                        </button>
                                                                    </Badge>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                    {index < selectedDoctor.availabilitySlots!.length - 1 && <Separator className="my-3" />}
                                                </React.Fragment>
                                            ))
                                    ) : (
                                        <p className="text-sm text-muted-foreground">No availability slots defined.</p>
                                    )}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            )}
        </div>
    );
}


