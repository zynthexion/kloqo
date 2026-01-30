'use client';

import React, { useEffect, useState, useTransition } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Edit, Save, Loader2, Clock, ArrowLeft } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import AppFrameLayout from '@/components/layout/app-frame';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

const operatingHoursTimeSlotSchema = z.object({
    open: z.string().min(1, 'Required'),
    close: z.string().min(1, 'Required'),
});

const operatingHoursDaySchema = z.object({
    day: z.string(),
    timeSlots: z.array(operatingHoursTimeSlotSchema),
    isClosed: z.boolean(),
});

const operatingHoursFormSchema = z.object({
    hours: z.array(operatingHoursDaySchema),
});

type OperatingHoursFormValues = z.infer<typeof operatingHoursFormSchema>;

export default function OperatingHoursPage() {
    const [isPending, startTransition] = useTransition();
    const [loading, setLoading] = useState(true);
    const [clinicDetails, setClinicDetails] = useState<any | null>(null);
    const [isEditingHours, setIsEditingHours] = useState(false);
    const [clinicId, setClinicId] = useState<string | null>(null);
    const { toast } = useToast();
    const router = useRouter();

    const hoursForm = useForm<OperatingHoursFormValues>({
        resolver: zodResolver(operatingHoursFormSchema),
        defaultValues: { hours: [] }
    });

    const { fields, update } = useFieldArray({
        control: hoursForm.control,
        name: "hours",
    });

    useEffect(() => {
        const id = localStorage.getItem('clinicId');
        setClinicId(id);
    }, []);

    useEffect(() => {
        const fetchClinicData = async () => {
            if (!clinicId) {
                setLoading(false);
                return;
            }
            setLoading(true);
            try {
                const clinicDocRef = doc(db, "clinics", clinicId);
                const clinicDocSnap = await getDoc(clinicDocRef);
                if (clinicDocSnap.exists()) {
                    const clinicData = clinicDocSnap.data();
                    setClinicDetails(clinicData);
                    if (clinicData.operatingHours) {
                        hoursForm.reset({ hours: clinicData.operatingHours });
                    }
                }
            } catch (error) {
                console.error("Error fetching clinic data:", error);
                toast({ variant: "destructive", title: "Error", description: "Failed to load clinic data." });
            } finally {
                setLoading(false);
            }
        };
        fetchClinicData();
    }, [clinicId, toast, hoursForm]);

    const onHoursSubmit = async (values: OperatingHoursFormValues) => {
        if (!clinicId) return;

        startTransition(async () => {
            const clinicRef = doc(db, 'clinics', clinicId);
            try {
                await updateDoc(clinicRef, { operatingHours: values.hours });
                setClinicDetails((prev: any) => (prev ? { ...prev, operatingHours: values.hours } : null));
                toast({ title: "Operating Hours Updated", description: "Clinic operating hours have been saved." });
                setIsEditingHours(false);
            } catch (error) {
                console.error("Error updating hours: ", error);
                toast({ variant: "destructive", title: "Update Failed", description: "Could not save operating hours." });
            }
        });
    };

    const handleCancelHours = () => {
        if (clinicDetails?.operatingHours) {
            hoursForm.reset({ hours: clinicDetails.operatingHours });
        }
        setIsEditingHours(false);
    }

    const handleTimeChange = (dayIndex: number, slotIndex: number, field: 'open' | 'close', value: string) => {
        const day = fields[dayIndex];
        const newTimeSlots = [...day.timeSlots];
        newTimeSlots[slotIndex][field] = value;
        update(dayIndex, { ...day, timeSlots: newTimeSlots });
    };

    const handleClosedToggle = (dayIndex: number, isClosed: boolean) => {
        const day = fields[dayIndex];
        update(dayIndex, { ...day, isClosed });
    };

    if (loading) {
        return (
            <AppFrameLayout>
                <div className="flex items-center justify-center h-full">
                    <Loader2 className="w-8 h-8 animate-spin" />
                </div>
            </AppFrameLayout>
        );
    }

    return (
        <AppFrameLayout>
            <div className="flex flex-col h-full">
                <header className="flex items-center gap-4 p-4 border-b">
                    <Link href="/settings">
                        <Button variant="ghost" size="icon">
                            <ArrowLeft className="w-5 h-5" />
                        </Button>
                    </Link>
                    <div className="flex-1">
                        <h1 className="text-xl font-bold">Operating Hours</h1>
                    </div>
                </header>

                <main className="flex-1 p-6 overflow-y-auto">
                    <Card>
                        {!clinicDetails ? <CardHeader><CardTitle>Clinic not found</CardTitle></CardHeader> : (
                            <>
                                <CardHeader>
                                    <div className="flex items-center justify-between">
                                        <div className="space-y-1">
                                            <CardTitle className="flex items-center gap-2">
                                                <Clock className="w-5 h-5" /> Clinic Schedule
                                            </CardTitle>
                                            <CardDescription>Manage your clinic's weekly schedule.</CardDescription>
                                        </div>
                                        {!isEditingHours && (
                                            <Button variant="outline" size="sm" onClick={() => setIsEditingHours(true)} disabled={isPending}>
                                                <Edit className="w-4 h-4 mr-2" /> Edit
                                            </Button>
                                        )}
                                    </div>
                                </CardHeader>
                                <Form {...hoursForm}>
                                    <form onSubmit={hoursForm.handleSubmit(onHoursSubmit)}>
                                        <CardContent className="space-y-4">
                                            {fields.map((hour, dayIndex) => (
                                                <div key={hour.id} className={cn("p-4 border rounded-lg", hour.isClosed && isEditingHours && "bg-muted/50")}>
                                                    <div className="flex items-center justify-between mb-4">
                                                        <p className={cn("w-24 font-semibold", hour.isClosed && isEditingHours && "text-muted-foreground")}>{hour.day}</p>
                                                        {isEditingHours && (
                                                            <div className="flex items-center space-x-2">
                                                                <Label htmlFor={`closed-switch-${dayIndex}`}>{hour.isClosed ? 'Closed' : 'Open'}</Label>
                                                                <Switch
                                                                    id={`closed-switch-${dayIndex}`}
                                                                    checked={!hour.isClosed}
                                                                    onCheckedChange={(checked) => handleClosedToggle(dayIndex, !checked)}
                                                                />
                                                            </div>
                                                        )}
                                                    </div>

                                                    {!hour.isClosed && (
                                                        <div className="space-y-3">
                                                            {hour.timeSlots.map((slot, slotIndex) => (
                                                                <div key={slotIndex} className="flex items-end gap-2">
                                                                    <div className="space-y-1 flex-grow">
                                                                        <Label htmlFor={`open-time-${dayIndex}-${slotIndex}`} className="text-xs">Open</Label>
                                                                        <Input
                                                                            id={`open-time-${dayIndex}-${slotIndex}`}
                                                                            type="time"
                                                                            defaultValue={slot.open}
                                                                            onChange={e => handleTimeChange(dayIndex, slotIndex, 'open', e.target.value)}
                                                                            disabled={!isEditingHours || isPending}
                                                                        />
                                                                    </div>
                                                                    <div className="space-y-1 flex-grow">
                                                                        <Label htmlFor={`close-time-${dayIndex}-${slotIndex}`} className="text-xs">Close</Label>
                                                                        <Input
                                                                            id={`close-time-${dayIndex}-${slotIndex}`}
                                                                            type="time"
                                                                            defaultValue={slot.close}
                                                                            onChange={e => handleTimeChange(dayIndex, slotIndex, 'close', e.target.value)}
                                                                            disabled={!isEditingHours || isPending}
                                                                        />
                                                                    </div>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}

                                                    {hour.isClosed && !isEditingHours && (
                                                        <p className="text-sm text-muted-foreground italic">Closed</p>
                                                    )}
                                                </div>
                                            ))}

                                            {isEditingHours && (
                                                <div className="flex justify-end gap-2 pt-4 sticky bottom-0 bg-background p-2 border-t mt-4">
                                                    <Button type="button" variant="ghost" onClick={handleCancelHours} disabled={isPending}>Cancel</Button>
                                                    <Button type="submit" disabled={isPending}>
                                                        {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                                                        Save Changes
                                                    </Button>
                                                </div>
                                            )}
                                        </CardContent>
                                    </form>
                                </Form>
                            </>
                        )}
                    </Card>
                </main>
            </div>
        </AppFrameLayout>
    );
}
