"use client";

import { useState, useTransition, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogClose,
} from "@/components/ui/dialog";
import {
    Form,
    FormControl,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { managePatient } from '@kloqo/shared-core';
import { clearPatientListCache } from '@/lib/patient-cache';
import { useUser } from '@/firebase/auth/use-user';
import { useLanguage } from '@/contexts/language-context';
import type { Patient } from '@/lib/types';

const getFormSchema = (t: any) => z.object({
    name: z.string()
        .min(3, { message: t.patientForm.nameMinLength })
        .regex(/^[a-zA-Z\s]+$/, { message: t.patientForm.nameAlphabetsOnly })
        .refine(name => !name.startsWith(' ') && !name.endsWith(' ') && !name.includes('  '), {
            message: t.patientForm.nameSpaces
        }),
    age: z.preprocess(
        (val) => (val === "" || val === undefined || val === null ? undefined : Number(val)),
        z.number({ required_error: t.patientForm.ageRequired, invalid_type_error: t.patientForm.ageRequired })
            .min(1, { message: t.patientForm.agePositive })
            .max(120, { message: t.patientForm.ageMax })
    ),
    sex: z.enum(["Male", "Female", "Other"], { required_error: t.patientForm.selectGender }),
    phone: z.string()
        .optional()
        .refine((val) => {
            if (!val || val.length === 0) return true;
            const cleaned = val.replace(/^\+91/, '').replace(/\D/g, '');
            return cleaned.length === 10;
        }, {
            message: t.patientForm.phonePlaceholder
        }),
    place: z.string().min(2, { message: t.patientForm.enterPlace }),
});

type RelativeFormValues = z.infer<ReturnType<typeof getFormSchema>>;

type RelativeDialogProps = {
    isOpen: boolean;
    setIsOpen: (isOpen: boolean) => void;
    patient: Patient;
    onSuccess: () => void;
    clinicId: string | null;
};

export function RelativeDialog({
    isOpen,
    setIsOpen,
    patient,
    onSuccess,
    clinicId,
}: RelativeDialogProps) {
    const { t } = useLanguage();
    const { user } = useUser();
    const [isPending, startTransition] = useTransition();
    const { toast } = useToast();

    const form = useForm<RelativeFormValues>({
        resolver: zodResolver(getFormSchema(t)),
        mode: 'onBlur',
        defaultValues: {
            name: patient.name || "",
            age: patient.age || undefined,
            sex: (patient.sex as any) || undefined,
            phone: patient.phone?.replace(/^\+91/, '') || "",
            place: patient.place || "",
        },
    });

    // Update form values if patient prop changes
    useEffect(() => {
        if (patient) {
            form.reset({
                name: patient.name || "",
                age: patient.age || undefined,
                sex: (patient.sex as any) || undefined,
                phone: patient.phone?.replace(/^\+91/, '') || "",
                place: patient.place || "",
            });
        }
    }, [patient, form]);

    const onSubmit = (values: RelativeFormValues) => {
        startTransition(async () => {
            try {
                let fullPhone = "";
                if (values.phone) {
                    fullPhone = `+91${values.phone.replace(/\D/g, '')}`;
                }

                await managePatient({
                    id: patient.id,
                    name: values.name,
                    age: values.age,
                    sex: values.sex,
                    phone: fullPhone,
                    communicationPhone: fullPhone || patient.communicationPhone || "",
                    place: values.place,
                    clinicId: clinicId || patient.clinicIds?.[0] || 'unknown',
                    bookingFor: 'update',
                });

                toast({
                    title: t.messages.success,
                    description: t.patientForm.confirmUnlinkDesc.replace('{name}', values.name),
                });

                if (user?.phoneNumber) {
                    clearPatientListCache(user.phoneNumber);
                }

                onSuccess();
                setIsOpen(false);
            } catch (error: any) {
                console.error("Error updating relative:", error);
                toast({
                    variant: "destructive",
                    title: t.common.error,
                    description: error.message || t.patientForm.patientCreationFailed,
                });
            }
        });
    };

    return (
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t.patientForm.editRelativeInfo}</DialogTitle>
                    <DialogDescription>
                        {t.patientForm.editRelativeDesc}
                    </DialogDescription>
                </DialogHeader>
                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                        <FormField
                            control={form.control}
                            name="name"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>{t.patientForm.name}</FormLabel>
                                    <FormControl>
                                        <Input placeholder={t.patientForm.enterPatientName} {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <div className="grid grid-cols-2 gap-4">
                            <FormField
                                control={form.control}
                                name="age"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>{t.patientForm.age}</FormLabel>
                                        <FormControl>
                                            <Input
                                                type="number"
                                                placeholder={t.patientForm.age}
                                                {...field}
                                                onChange={(e) => field.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
                                            />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                            <FormField
                                control={form.control}
                                name="sex"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>{t.patientForm.gender}</FormLabel>
                                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                                            <FormControl>
                                                <SelectTrigger>
                                                    <SelectValue placeholder={t.patientForm.selectGender} />
                                                </SelectTrigger>
                                            </FormControl>
                                            <SelectContent>
                                                <SelectItem value="Male">{t.patientForm.male}</SelectItem>
                                                <SelectItem value="Female">{t.patientForm.female}</SelectItem>
                                                <SelectItem value="Other">{t.patientForm.other}</SelectItem>
                                            </SelectContent>
                                        </Select>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                        </div>
                        <FormField
                            control={form.control}
                            name="phone"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>{t.patientForm.phone} ({t.common.optional})</FormLabel>
                                    <FormControl>
                                        <div className="relative">
                                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">+91</span>
                                            <Input
                                                type="tel"
                                                {...field}
                                                className="pl-12"
                                                placeholder={t.patientForm.phonePlaceholder}
                                                onChange={(e) => {
                                                    const value = e.target.value.replace(/\D/g, '').slice(0, 10);
                                                    field.onChange(value);
                                                }}
                                            />
                                        </div>
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="place"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>{t.patientForm.place}</FormLabel>
                                    <FormControl>
                                        <Input placeholder={t.patientForm.enterPlace} {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <DialogFooter className="flex gap-2 sm:gap-0">
                            <Button type="button" variant="ghost" onClick={() => setIsOpen(false)}>
                                {t.common.cancel}
                            </Button>
                            <Button type="submit" disabled={isPending}>
                                {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                {t.patientForm.saveChanges}
                            </Button>
                        </DialogFooter>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
    );
}
