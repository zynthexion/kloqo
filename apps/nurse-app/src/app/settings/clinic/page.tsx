'use client';

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { ArrowLeft, Save, Edit, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useToast } from '@/hooks/use-toast';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import AppFrameLayout from '@/components/layout/app-frame';

const settingsFormSchema = z.object({
  walkInTokenAllotment: z.coerce.number().min(2, "Walk-in token allotment must be at least 2."),
});
type SettingsFormValues = z.infer<typeof settingsFormSchema>;

export default function ClinicSettingsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [clinicId, setClinicId] = useState<string | null>(null);

  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsFormSchema),
    defaultValues: {
      walkInTokenAllotment: 5,
    }
  });

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }

    const fetchClinicSettings = async () => {
      try {
        // Get user's clinicId
        const userDocRef = doc(db, 'users', user.uid);
        const userDocSnap = await getDoc(userDocRef);
        if (!userDocSnap.exists()) {
          setLoading(false);
          return;
        }

        const userData = userDocSnap.data();
        const clinicId = userData?.clinicId;
        if (!clinicId) {
          setLoading(false);
          toast({
            variant: 'destructive',
            title: 'Error',
            description: 'Clinic ID not found.',
          });
          return;
        }

        const clinicDocRef = doc(db, 'clinics', clinicId);
        const clinicDocSnap = await getDoc(clinicDocRef);
        if (clinicDocSnap.exists()) {
          const clinicData = clinicDocSnap.data();
          form.reset({
            walkInTokenAllotment: clinicData.walkInTokenAllotment || 5,
          });
        }
      } catch (error) {
        console.error('Error fetching clinic settings:', error);
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Failed to load clinic settings.',
        });
      } finally {
        setLoading(false);
      }
    };

    fetchClinicSettings();
  }, [user, form, toast]);

  const onSubmit = async (values: SettingsFormValues) => {
    if (!clinicId) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Clinic ID not found.',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const clinicRef = doc(db, 'clinics', clinicId);
      await updateDoc(clinicRef, {
        walkInTokenAllotment: values.walkInTokenAllotment,
      });

      toast({
        title: 'Settings Updated',
        description: 'Clinic settings have been saved successfully.',
      });
      setIsEditing(false);
    } catch (error) {
      console.error('Error updating settings:', error);
      toast({
        variant: 'destructive',
        title: 'Update Failed',
        description: 'Could not save settings.',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (clinicId) {
      // Reset form to original values
      const clinicRef = doc(db, 'clinics', clinicId);
      getDoc(clinicRef).then((snap) => {
        if (snap.exists()) {
          const clinicData = snap.data();
          form.reset({
            walkInTokenAllotment: clinicData.walkInTokenAllotment || 5,
          });
        }
      });
    }
    setIsEditing(false);
  };

  if (loading) {
    return (
      <AppFrameLayout>
        <div className="flex items-center justify-center h-full">
          <Loader2 className="h-8 w-8 animate-spin" />
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
              <ArrowLeft />
            </Button>
          </Link>
          <div className="flex-1">
            <h1 className="text-xl font-bold">Clinic Settings</h1>
          </div>
        </header>
        <main className="flex-1 p-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Clinic Settings</CardTitle>
                  <CardDescription>Configure walk-in token allotment settings.</CardDescription>
                </div>
                {!isEditing && (
                  <Button variant="outline" size="icon" onClick={() => setIsEditing(true)} disabled={isSubmitting}>
                    <Edit className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </CardHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)}>
                <CardContent className="space-y-4">
                  <FormField
                    control={form.control}
                    name="walkInTokenAllotment"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Walk-in Token Allotment</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min="2"
                            {...field}
                            onChange={e => field.onChange(parseInt(e.target.value, 10) || 2)}
                            disabled={!isEditing || isSubmitting}
                            value={field.value || ''}
                          />
                        </FormControl>
                        <FormDescription>
                          Allot one walk-in token after every X online tokens. This determines how many slots to skip before placing a walk-in patient.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </CardContent>
                {isEditing && (
                  <CardFooter className="flex justify-end gap-2">
                    <Button type="button" variant="ghost" onClick={handleCancel} disabled={isSubmitting}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={isSubmitting}>
                      {isSubmitting ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Saving...
                        </>
                      ) : (
                        <>
                          <Save className="mr-2 h-4 w-4" />
                          Save Settings
                        </>
                      )}
                    </Button>
                  </CardFooter>
                )}
              </form>
            </Form>
          </Card>
        </main>
      </div>
    </AppFrameLayout>
  );
}



