
'use client';

import { useState, useEffect, Suspense } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Loader2, CheckCircle } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { managePatient } from '@kloqo/shared-core';
import { useToast } from '@/hooks/use-toast';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const formSchema = z.object({
    name: z.string().min(2, { message: "Name must be at least 2 characters." }),
    age: z.coerce.number().int().positive({ message: "Age must be a positive number." }).min(1, { message: "Please enter a valid age." }),
    place: z.string().min(2, { message: "Place is required." }),
    phone: z.string()
        .refine((val) => {
            if (!val || val.length === 0) return false; // Phone is required
            // Strip +91 prefix if present, then check for exactly 10 digits
            const cleaned = val.replace(/^\+91/, '').replace(/\D/g, ''); // Remove +91 and non-digits
            if (cleaned.length === 0) return false; // If all digits removed, invalid
            if (cleaned.length < 10) return false; // Less than 10 digits is invalid
            if (cleaned.length > 10) return false; // More than 10 digits is invalid
            return /^\d{10}$/.test(cleaned);
        }, {
            message: "Please enter exactly 10 digits for the phone number."
        }),
    sex: z.string().min(1, { message: "Sex is required." }),
});

export default function PatientRegistrationForm() {
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isSubmitted, setIsSubmitted] = useState(false);
    const searchParams = useSearchParams();
    const { toast } = useToast();
    const [clinicId, setClinicId] = useState<string | null>(null);

    useEffect(() => {
        const id = searchParams.get('clinicId');
        if (id) {
            setClinicId(id);
        } else {
            // Handle case where clinicId is missing. Maybe show an error.
            toast({ variant: 'destructive', title: 'Error', description: 'Clinic ID is missing from the link.' });
        }
    }, [searchParams, toast]);

    const form = useForm<z.infer<typeof formSchema>>({
        resolver: zodResolver(formSchema),
        defaultValues: {
            name: '',
            age: undefined,
            place: '',
            phone: '',
            sex: '',
        },
    });

    async function onSubmit(values: z.infer<typeof formSchema>) {
        if (!clinicId) {
            toast({ variant: 'destructive', title: 'Error', description: 'Cannot register patient without a clinic ID.' });
            return;
        }
        setIsSubmitting(true);
        try {
            // Clean phone: remove +91 if user entered it, remove any non-digits, then ensure exactly 10 digits
            let fullPhoneNumber = "";
            if (values.phone) {
                const cleaned = values.phone.replace(/^\+91/, '').replace(/\D/g, ''); // Remove +91 prefix and non-digits
                if (cleaned.length === 10) {
                    fullPhoneNumber = `+91${cleaned}`; // Add +91 prefix when saving
                }
            }
            if (!fullPhoneNumber) {
                toast({ variant: 'destructive', title: 'Error', description: 'Please enter a valid 10-digit phone number.' });
                setIsSubmitting(false);
                return;
            }
            // For a public form, we create a new "primary user" context based on their phone number.
            const mockBookingUserId = `user_${fullPhoneNumber}`;
            await managePatient({
                name: values.name,
                age: values.age,
                place: values.place,
                phone: fullPhoneNumber,
                sex: values.sex,
                clinicId,
                bookingUserId: mockBookingUserId,
                bookingFor: 'self',
            });
            setIsSubmitted(true);
        } catch (error: any) {
            console.error('Patient registration failed:', error);
            toast({
                variant: 'destructive',
                title: 'Registration Failed',
                description: error.message || 'An unexpected error occurred.'
            });
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <div className="w-full h-full flex flex-col items-center justify-center bg-muted/20 p-4">
            <Card className="w-full max-w-sm rounded-2xl border bg-card shadow-lg">
                <CardHeader className="text-center">
                    <CardTitle className="text-2xl">Walk-in Registration</CardTitle>
                    <CardDescription>
                        Please enter your details to register for your appointment.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {isSubmitted ? (
                        <div className="flex flex-col items-center justify-center text-center gap-4 py-8">
                            <CheckCircle className="h-16 w-16 text-green-500" />
                            <h2 className="text-xl font-semibold">Registration Complete!</h2>
                            <p className="text-muted-foreground">
                                Thank you. You can now close this window. Your token will be generated by the receptionist.
                            </p>
                        </div>
                    ) : (
                        <Form {...form}>
                            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                                <FormField
                                    control={form.control}
                                    name="name"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>Full Name</FormLabel>
                                            <FormControl>
                                                <Input placeholder="e.g. Jane Smith" {...field} />
                                            </FormControl>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />
                                <FormField
                                    control={form.control}
                                    name="age"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>Age</FormLabel>
                                            <FormControl>
                                                <Input type="number" placeholder="e.g. 34" {...field} />
                                            </FormControl>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />
                                <FormField
                                    control={form.control}
                                    name="phone"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>Phone Number</FormLabel>
                                            <FormControl>
                                                <div className="relative">
                                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">+91</span>
                                                    <Input
                                                        type="tel"
                                                        {...field}
                                                        value={field.value || ''}
                                                        className="pl-12"
                                                        placeholder="Enter 10-digit number"
                                                        onChange={(e) => {
                                                            // Only allow digits, max 10 digits
                                                            let value = e.target.value.replace(/\D/g, ''); // Remove all non-digits
                                                            // Remove +91 if user tries to enter it manually
                                                            value = value.replace(/^91/, '');
                                                            // Limit to 10 digits
                                                            if (value.length > 10) {
                                                                value = value.slice(0, 10);
                                                            }
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
                                    name="sex"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>Sex</FormLabel>
                                            <Select onValueChange={field.onChange} defaultValue={field.value}>
                                                <FormControl>
                                                    <SelectTrigger>
                                                        <SelectValue placeholder="Select sex" />
                                                    </SelectTrigger>
                                                </FormControl>
                                                <SelectContent>
                                                    <SelectItem value="Male">Male</SelectItem>
                                                    <SelectItem value="Female">Female</SelectItem>
                                                    <SelectItem value="Other">Other</SelectItem>
                                                </SelectContent>
                                            </Select>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />
                                <FormField
                                    control={form.control}
                                    name="place"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>Place</FormLabel>
                                            <FormControl>
                                                <Input placeholder="e.g. Cityville" {...field} />
                                            </FormControl>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />
                                <Button type="submit" className="w-full mt-6 bg-[#f38d17] hover:bg-[#f38d17]/90" disabled={isSubmitting || !clinicId}>
                                    {isSubmitting ? (
                                        <>
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                            Submitting...
                                        </>
                                    ) : (
                                        'Submit Registration'
                                    )}
                                </Button>
                            </form>
                        </Form>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
