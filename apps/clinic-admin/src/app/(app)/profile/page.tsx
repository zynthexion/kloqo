
"use client";

import { useEffect, useState, useTransition } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { ProfileHeader } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { collection, getDocs, setDoc, doc, query, where, getDoc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { User, Appointment, TimeSlot } from "@/lib/types";
import { UserCircle, Edit, Save, X, Building, Loader2, Clock, PlusCircle, Trash2, Settings } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/firebase";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { EmailAuthProvider, reauthenticateWithCredential, updatePassword } from "firebase/auth";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";


const passwordFormSchema = z.object({
    currentPassword: z.string().min(1, "Please enter your current password."),
    newPassword: z.string().min(6, "New password must be at least 6 characters."),
    confirmPassword: z.string().min(6, "Please confirm your new password."),
}).refine(data => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
});
type PasswordFormValues = z.infer<typeof passwordFormSchema>;

const profileFormSchema = z.object({
    name: z.string().min(2, "Name must be at least 2 characters."),
    phone: z.string().min(10, "Phone number must be at least 10 digits."),
});
type ProfileFormValues = z.infer<typeof profileFormSchema>;

const clinicFormSchema = z.object({
    name: z.string().min(2, "Clinic name must be at least 2 characters."),
    type: z.enum(['Single Doctor', 'Multi-Doctor']),
    numDoctors: z.coerce.number().min(1),
    clinicRegNumber: z.string().optional(),
    addressLine1: z.string().min(1, "Address Line 1 is required."),
    addressLine2: z.string().optional(),
    city: z.string().min(1, "City is required."),
    district: z.string().optional(),
    state: z.string().min(1, "State is required."),
    pincode: z.string().min(1, "Pincode is required."),
    mapsLink: z.string().url().optional().or(z.literal('')),
}).refine((data) => {
    // This will be validated in the component with currentDoctorCount
    return true;
}, {
    message: "Number of doctors cannot be less than current doctor count.",
    path: ["numDoctors"],
});
type ClinicFormValues = z.infer<typeof clinicFormSchema>;

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

const settingsFormSchema = z.object({
  walkInTokenAllotment: z.coerce.number().min(2, "Walk-in token allotment must be at least 2."),
  skippedTokenRecurrence: z.coerce.number().min(1, "Skipped token recurrence must be at least 1."),
});
type SettingsFormValues = z.infer<typeof settingsFormSchema>;


export default function ProfilePage() {
  const auth = useAuth();
  const [activeView, setActiveView] = useState("profile");
  const [isPending, startTransition] = useTransition();
  const [loading, setLoading] = useState(true);
  const [userProfile, setUserProfile] = useState<User | null>(null);
  const [clinicDetails, setClinicDetails] = useState<any | null>(null);
  const [currentDoctorCount, setCurrentDoctorCount] = useState(0);
  const [formKey, setFormKey] = useState(0);
  
  const [showPassword, setShowPassword] = useState(false);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [isEditingClinic, setIsEditingClinic] = useState(false);
  const [isEditingHours, setIsEditingHours] = useState(false);
  const [isEditingSettings, setIsEditingSettings] = useState(false);
  
  const { toast } = useToast();

  const passwordForm = useForm<PasswordFormValues>({ resolver: zodResolver(passwordFormSchema), defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" } });
  const profileForm = useForm<ProfileFormValues>({ resolver: zodResolver(profileFormSchema), defaultValues: { name: "", phone: "" } });
  const clinicForm = useForm<ClinicFormValues>({ 
      resolver: zodResolver(clinicFormSchema), 
      defaultValues: { 
        name: "", 
        type: "Single Doctor", 
        numDoctors: 1, 
        clinicRegNumber: "", 
        addressLine1: "", 
        addressLine2: "", 
        city: "", 
        district: "", 
        state: "", 
        pincode: "", 
        mapsLink: "" 
      },
      mode: "onChange"
  });
  const hoursForm = useForm<OperatingHoursFormValues>({
    resolver: zodResolver(operatingHoursFormSchema),
    defaultValues: { hours: [] }
  });

  const settingsForm = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsFormSchema),
    defaultValues: {
      walkInTokenAllotment: 5,
      skippedTokenRecurrence: 3,
    }
  });

  const { fields, update } = useFieldArray({
    control: hoursForm.control,
    name: "hours",
  });


  useEffect(() => {
    if (!auth.currentUser) {
      setLoading(false);
      return;
    }
    const fetchUserData = async () => {
      setLoading(true);
      try {
        const userDocRef = doc(db, "users", auth.currentUser!.uid);
        const userDocSnap = await getDoc(userDocRef);
        if (userDocSnap.exists()) {
          const userData = userDocSnap.data() as User;
          setUserProfile(userData);

          const profileResetData = {
            name: userData.name,
            phone: userData.phone.replace('+91',''),
          };
          profileForm.reset(profileResetData);

          if (userData.clinicId) {
            const clinicId = userData.clinicId;
            const clinicDocRef = doc(db, "clinics", clinicId);
            const clinicDocSnap = await getDoc(clinicDocRef);
            if (clinicDocSnap.exists()) {
              const clinicData = clinicDocSnap.data();
              setClinicDetails(clinicData);

              // Form reset will be handled by the separate useEffect

              const hoursResetData = {
                hours: clinicData.operatingHours,
              };
              hoursForm.reset(hoursResetData);

              const settingsResetData = {
                walkInTokenAllotment: clinicData.walkInTokenAllotment || 5,
                skippedTokenRecurrence: clinicData.skippedTokenRecurrence || 3,
              };
              settingsForm.reset(settingsResetData);
              
              const doctorsQuery = query(collection(db, "doctors"), where("clinicId", "==", clinicId));
              const doctorsSnapshot = await getDocs(doctorsQuery);
              const doctorCount = doctorsSnapshot.size;
              setCurrentDoctorCount(doctorCount);
            }

          }
        }
      } catch (error) {
        console.error("Error fetching initial data:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchUserData();
  }, [auth.currentUser, profileForm, clinicForm, hoursForm, settingsForm]);

  // Separate effect to handle clinic form reset when clinicDetails changes
  useEffect(() => {
    if (clinicDetails && clinicForm) {
      const clinicResetData = {
        name: clinicDetails.name || '',
        type: clinicDetails.type || 'Single Doctor',
        numDoctors: clinicDetails.numDoctors || 1,
        clinicRegNumber: clinicDetails.clinicRegNumber || '',
        addressLine1: clinicDetails.addressDetails?.line1 || '',
        addressLine2: clinicDetails.addressDetails?.line2 || '',
        city: clinicDetails.addressDetails?.city || '',
        district: clinicDetails.addressDetails?.district || '',
        state: clinicDetails.addressDetails?.state || '',
        pincode: clinicDetails.addressDetails?.pincode || '',
        mapsLink: clinicDetails.mapsLink || '',
      };
      
      // Use setTimeout to ensure the form reset happens after the component is fully rendered
      setTimeout(() => {
        clinicForm.reset(clinicResetData);
        setFormKey(prev => prev + 1); // Force re-render
      }, 100);
    }
  }, [clinicDetails, clinicForm]);

  const onSettingsSubmit = async (values: SettingsFormValues) => {
    if (!userProfile?.clinicId) return;

    startTransition(async () => {
      const clinicRef = doc(db, 'clinics', userProfile.clinicId!);
      try {
        await updateDoc(clinicRef, {
          walkInTokenAllotment: values.walkInTokenAllotment,
          skippedTokenRecurrence: values.skippedTokenRecurrence,
        });
        setClinicDetails((prev: any) => prev ? {
          ...prev,
          walkInTokenAllotment: values.walkInTokenAllotment,
          skippedTokenRecurrence: values.skippedTokenRecurrence,
        } : null);
        toast({ title: "Settings Updated", description: "Clinic settings have been saved successfully." });
        setIsEditingSettings(false);
      } catch (error) {
        console.error("Error updating settings: ", error);
        toast({ variant: "destructive", title: "Update Failed", description: "Could not save settings." });
      }
    });
  };

  const handleCancelSettings = () => {
    if (clinicDetails) {
      settingsForm.reset({
        walkInTokenAllotment: clinicDetails.walkInTokenAllotment || 5,
        skippedTokenRecurrence: clinicDetails.skippedTokenRecurrence || 3,
      });
    }
    setIsEditingSettings(false);
  };



  const onPasswordSubmit = async (values: PasswordFormValues) => {
    if (!auth.currentUser || !auth.currentUser.email) return;

    startTransition(async () => {
        const credential = EmailAuthProvider.credential(auth.currentUser!.email!, values.currentPassword);
        try {
            await reauthenticateWithCredential(auth.currentUser!, credential);
            await updatePassword(auth.currentUser!, values.newPassword);
            toast({ title: "Password Updated", description: "Your password has been changed successfully." });
            passwordForm.reset();
        } catch (error: any) {
            console.error("Password update error:", error);
            toast({
                variant: "destructive",
                title: "Update Failed",
                description: error.code === 'auth/wrong-password' 
                    ? "Incorrect current password. Please try again."
                    : "Failed to update password. Please try again later.",
            });
        }
    });
  }

  const onProfileSubmit = async (values: ProfileFormValues) => {
      if (!auth.currentUser) return;
      
      startTransition(async () => {
          const userRef = doc(db, 'users', auth.currentUser!.uid);
          try {
              const phoneWithCountryCode = values.phone.startsWith('+91') ? values.phone : `+91${values.phone}`;
              await updateDoc(userRef, { name: values.name, phone: phoneWithCountryCode });
              setUserProfile(prev => prev ? {...prev, name: values.name, phone: phoneWithCountryCode} : null);
              toast({ title: "Profile Updated", description: "Your personal information has been changed successfully." });
              setIsEditingProfile(false);
          } catch (error) {
              console.error(error);
              toast({ variant: "destructive", title: "Update Failed", description: "Could not update your profile." });
          }
      });
  }
  
  const onClinicSubmit = async (values: ClinicFormValues) => {
    if (!userProfile?.clinicId) return;

    // Validate clinic type change
    if (values.type === 'Single Doctor' && currentDoctorCount > 1) {
        toast({ 
            variant: "destructive", 
            title: "Cannot Switch to Single Doctor", 
            description: `You have ${currentDoctorCount} doctors registered. Remove doctors first or keep as Multi-Doctor clinic.` 
        });
        return;
    }

    // Validate that numDoctors is not less than current doctor count
    if (values.numDoctors < currentDoctorCount) {
        toast({ 
            variant: "destructive", 
            title: "Invalid Doctor Limit", 
            description: `Cannot set doctor limit to ${values.numDoctors}. You currently have ${currentDoctorCount} doctors. Please increase the limit or remove some doctors first.` 
        });
        return;
    }

    // Validate minimum limit for Multi-Doctor clinic
    if (values.type === 'Multi-Doctor' && values.numDoctors < 2) {
        toast({ 
            variant: "destructive", 
            title: "Invalid Doctor Limit", 
            description: `Multi-Doctor clinic must have at least 2 doctor slots. Current limit: ${values.numDoctors}` 
        });
        return;
    }

    startTransition(async () => {
        const clinicRef = doc(db, 'clinics', userProfile.clinicId!);
        try {
            await updateDoc(clinicRef, { 
                name: values.name,
                type: values.type,
                numDoctors: values.numDoctors,
                clinicRegNumber: values.clinicRegNumber,
                addressDetails: {
                    line1: values.addressLine1,
                    line2: values.addressLine2,
                    city: values.city,
                    district: values.district,
                    state: values.state,
                    pincode: values.pincode,
                },
                mapsLink: values.mapsLink,
            });
            setClinicDetails((prev: any) => prev ? {...prev, ...values} : null);
            toast({ title: "Clinic Details Updated", description: "Your clinic's information has been changed successfully." });
            setIsEditingClinic(false);
        } catch (error) {
            console.error(error);
            toast({ variant: "destructive", title: "Update Failed", description: "Could not update clinic details." });
        }
    });
  }

  const onHoursSubmit = async (values: OperatingHoursFormValues) => {
    if (!userProfile?.clinicId) return;
    
    startTransition(async () => {
        const clinicRef = doc(db, 'clinics', userProfile.clinicId!);
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

  const handleCancelProfile = () => { if (userProfile) { profileForm.reset({ name: userProfile.name, phone: userProfile.phone.replace('+91','') }); } setIsEditingProfile(false); }
  const handleCancelClinic = () => { 
    if (clinicDetails) { 
        clinicForm.reset({ 
            name: clinicDetails.name || '',
            type: clinicDetails.type || 'Single Doctor',
            numDoctors: clinicDetails.numDoctors || 1,
            clinicRegNumber: clinicDetails.clinicRegNumber || '',
            addressLine1: clinicDetails.addressDetails?.line1 || '',
            addressLine2: clinicDetails.addressDetails?.line2 || '',
            city: clinicDetails.addressDetails?.city || '',
            district: clinicDetails.addressDetails?.district || '',
            state: clinicDetails.addressDetails?.state || '',
            pincode: clinicDetails.addressDetails?.pincode || '',
            mapsLink: clinicDetails.mapsLink || '',
        }); 
    } 
    setIsEditingClinic(false); 
  }

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
  
  const addTimeSlot = (dayIndex: number) => {
    const day = fields[dayIndex];
    const newTimeSlots = [...day.timeSlots, { open: '14:00', close: '18:00' }];
    update(dayIndex, { ...day, timeSlots: newTimeSlots });
  };
  
  const removeTimeSlot = (dayIndex: number, slotIndex: number) => {
    const day = fields[dayIndex];
    const newTimeSlots = day.timeSlots.filter((_, index) => index !== slotIndex);
    update(dayIndex, { ...day, timeSlots: newTimeSlots });
  };

  const handleClosedToggle = (dayIndex: number, isClosed: boolean) => {
    const day = fields[dayIndex];
    update(dayIndex, { ...day, isClosed });
  };

  const renderContent = () => {
      switch(activeView) {
          case 'profile':
              return (
                  <Card>
                    {!userProfile ? <CardHeader><CardTitle>Loading...</CardTitle></CardHeader> : (
                      <>
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <CardTitle>Login & Personal Information</CardTitle>
                                {!isEditingProfile && (
                                    <Button variant="outline" size="icon" onClick={() => setIsEditingProfile(true)} disabled={isPending}>
                                        <Edit className="w-4 h-4"/>
                                    </Button>
                                )}
                            </div>
                            <CardDescription>Your personal and login information.</CardDescription>
                        </CardHeader>
                        <Form {...profileForm}>
                            <form onSubmit={profileForm.handleSubmit(onProfileSubmit)}>
                                <CardContent className="space-y-4">
                                    <FormField control={profileForm.control} name="name" render={({ field }) => (
                                        <FormItem><FormLabel>Admin Name</FormLabel><FormControl><Input {...field} disabled={!isEditingProfile || isPending} /></FormControl><FormMessage /></FormItem>
                                    )}/>
                                    <FormItem><FormLabel>Email Address</FormLabel><Input type="email" value={userProfile?.email || ""} disabled /></FormItem>
                                    <FormField control={profileForm.control} name="phone" render={({ field }) => (
                                        <FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} disabled={!isEditingProfile || isPending} /></FormControl><FormMessage /></FormItem>
                                    )}/>
                                    {isEditingProfile && (
                                        <div className="flex justify-end gap-2 pt-4">
                                            <Button type="button" variant="ghost" onClick={handleCancelProfile} disabled={isPending}>Cancel</Button>
                                            <Button type="submit" disabled={isPending}>
                                                {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : <Save className="mr-2 h-4 w-4" />}
                                                Save Changes
                                            </Button>
                                        </div>
                                    )}
                                </CardContent>
                            </form>
                        </Form>
                        <Separator />
                        <CardFooter className="pt-6">
                            <Form {...passwordForm}>
                                <form onSubmit={passwordForm.handleSubmit(onPasswordSubmit)} className="w-full space-y-4">
                                    <p className="font-medium text-sm">Change Password</p>
                                    <FormField control={passwordForm.control} name="currentPassword" render={({ field }) => (
                                        <FormItem><FormLabel>Current Password</FormLabel><FormControl><Input type="password" {...field} /></FormControl><FormMessage /></FormItem>
                                    )}/>
                                    <FormField control={passwordForm.control} name="newPassword" render={({ field }) => (
                                        <FormItem><FormLabel>New Password</FormLabel><FormControl><Input type="password" {...field} /></FormControl><FormMessage /></FormItem>
                                    )}/>
                                    <FormField control={passwordForm.control} name="confirmPassword" render={({ field }) => (
                                        <FormItem><FormLabel>Confirm New Password</FormLabel><FormControl><Input type="password" {...field} /></FormControl><FormMessage /></FormItem>
                                    )}/>
                                    <Button type="submit" variant="secondary" className="w-full" disabled={isPending}>
                                      {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : null}
                                      Set New Password
                                    </Button>
                                </form>
                            </Form>
                        </CardFooter>
                      </>
                    )}
                  </Card>
              );
          case 'clinic':
              if (!clinicDetails) {
                  return <Card><CardHeader><CardTitle>Loading Clinic Details...</CardTitle></CardHeader></Card>;
              }
              const isMultiDoctorClinic = clinicForm.watch('type') === 'Multi-Doctor';
              return (
                   <Card>
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <CardTitle>General Information</CardTitle>
                                {!isEditingClinic && (
                                    <Button variant="outline" size="icon" onClick={() => setIsEditingClinic(true)} disabled={isPending}>
                                        <Edit className="w-4 h-4"/>
                                    </Button>
                                )}
                            </div>
                            <CardDescription>General information about your clinic.</CardDescription>
                        </CardHeader>
                        <Form {...clinicForm} key={`clinic-form-${formKey}`}>
                            <form onSubmit={clinicForm.handleSubmit(onClinicSubmit)}>
                                <CardContent className="space-y-4">
                                    <FormField control={clinicForm.control} name="name" render={({ field }) => (
                                        <FormItem><FormLabel>Clinic Name</FormLabel><FormControl><Input {...field} disabled={!isEditingClinic || isPending} placeholder="Enter clinic name" value={field.value || ''} /></FormControl><FormMessage /></FormItem>
                                    )}/>
                                    <FormField control={clinicForm.control} name="type" render={({ field }) => {
                                      const handleTypeChange = (value: string) => {
                                        field.onChange(value);
                                        // If switching to Single Doctor, set numDoctors to 1
                                        if (value === 'Single Doctor') {
                                          clinicForm.setValue('numDoctors', 1);
                                        }
                                        // If switching to Multi-Doctor and current limit is 1, set it to 2
                                        else if (value === 'Multi-Doctor' && clinicForm.getValues('numDoctors') < 2) {
                                          clinicForm.setValue('numDoctors', Math.max(2, currentDoctorCount));
                                        }
                                      };
                                      
                                      return (
                                        <FormItem>
                                          <FormLabel>Clinic Type</FormLabel>
                                          <Select 
                                            onValueChange={handleTypeChange} 
                                            value={field.value} 
                                            disabled={!isEditingClinic || isPending}
                                          >
                                            <FormControl>
                                              <SelectTrigger>
                                                <SelectValue />
                                              </SelectTrigger>
                                            </FormControl>
                                            <SelectContent>
                                              <SelectItem 
                                                value="Single Doctor" 
                                                disabled={currentDoctorCount > 1}
                                              >
                                                Single Doctor
                                                {currentDoctorCount > 1 && " (Not available - Multiple doctors exist)"}
                                              </SelectItem>
                                                <SelectItem value="Multi-Doctor">Multi-Doctor</SelectItem>
                                            </SelectContent>
                                        </Select>
                                          {currentDoctorCount > 1 && field.value === 'Multi-Doctor' && (
                                            <FormDescription className="text-xs text-amber-600">
                                              Cannot switch to Single Doctor with {currentDoctorCount} doctors registered. Remove doctors first or keep as Multi-Doctor.
                                            </FormDescription>
                                          )}
                                          <FormMessage />
                                        </FormItem>
                                      );
                                    }}/>
                                    <FormField
                                      control={clinicForm.control}
                                      name="numDoctors"
                                      render={({ field }) => {
                                        const currentLimit = clinicForm.watch('numDoctors') || clinicDetails?.numDoctors || 0;
                                        const isAtLimit = currentDoctorCount >= currentLimit;
                                        const minValue = isMultiDoctorClinic ? Math.max(2, currentDoctorCount) : 1;
                                        const isSingleDoctor = clinicForm.watch('type') === 'Single Doctor';
                                        
                                        return (
                                          <FormItem>
                                            <FormLabel>Number of Doctors Limit</FormLabel>
                                            <FormControl>
                                              <Input
                                                type="number"
                                                {...field}
                                                onChange={e => {
                                                  if (isSingleDoctor) return; // Don't allow changes for Single Doctor
                                                  const value = parseInt(e.target.value, 10) || 0;
                                                  const validValue = Math.max(minValue, value);
                                                  field.onChange(validValue);
                                                }}
                                                disabled={!isEditingClinic || isSingleDoctor || isPending}
                                                min={minValue}
                                                className={isAtLimit ? "border-red-500" : ""}
                                                placeholder={isMultiDoctorClinic ? "2" : "1"}
                                                value={isSingleDoctor ? 1 : field.value}
                                              />
                                            </FormControl>
                                            <FormDescription className="text-xs">
                                              Currently using {currentDoctorCount} of {currentLimit} available slots.
                                              {isSingleDoctor && (
                                                <span className="text-gray-600"> Single Doctor clinic is limited to 1 doctor.</span>
                                              )}
                                              {isMultiDoctorClinic && (
                                                <span className="text-blue-600"> Minimum limit for Multi-Doctor clinic is 2.</span>
                                              )}
                                              {isAtLimit && !isSingleDoctor && (
                                                <span className="text-red-600 font-medium"> - Limit reached! Increase the limit to add more doctors.</span>
                                              )}
                                            </FormDescription>
                                            <FormMessage />
                                          </FormItem>
                                        );
                                      }}
                                    />
                                    <FormField control={clinicForm.control} name="clinicRegNumber" render={({ field }) => (
                                        <FormItem><FormLabel>Clinic Registration Number</FormLabel><FormControl><Input {...field} disabled={!isEditingClinic || isPending} value={field.value || ''} /></FormControl><FormMessage /></FormItem>
                                    )}/>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                      <FormField control={clinicForm.control} name="addressLine1" render={({ field }) => (
                                        <FormItem className="md:col-span-2">
                                          <FormLabel>Address Line 1 <span className="text-destructive">*</span></FormLabel>
                                          <FormControl>
                                            <Input placeholder="Building Name, Street Name" {...field} disabled={!isEditingClinic || isPending} />
                                          </FormControl>
                                          <FormMessage />
                                        </FormItem>
                                      )}/>
                                      <FormField control={clinicForm.control} name="addressLine2" render={({ field }) => (
                                        <FormItem className="md:col-span-2">
                                          <FormLabel>Address Line 2 (Optional)</FormLabel>
                                          <FormControl>
                                            <Input placeholder="Landmark, Area" {...field} disabled={!isEditingClinic || isPending} />
                                          </FormControl>
                                          <FormMessage />
                                        </FormItem>
                                      )}/>
                                      <FormField control={clinicForm.control} name="city" render={({ field }) => (
                                        <FormItem>
                                          <FormLabel>City / Town <span className="text-destructive">*</span></FormLabel>
                                          <FormControl>
                                            <Input placeholder="e.g., Kochi" {...field} disabled={!isEditingClinic || isPending} />
                                          </FormControl>
                                          <FormMessage />
                                        </FormItem>
                                      )}/>
                                      <FormField control={clinicForm.control} name="district" render={({ field }) => (
                                        <FormItem>
                                          <FormLabel>District (Optional)</FormLabel>
                                          <FormControl>
                                            <Input placeholder="e.g., Ernakulam" {...field} disabled={!isEditingClinic || isPending} />
                                          </FormControl>
                                          <FormMessage />
                                        </FormItem>
                                      )}/>
                                      <FormField control={clinicForm.control} name="state" render={({ field }) => (
                                        <FormItem>
                                          <FormLabel>State <span className="text-destructive">*</span></FormLabel>
                                          <FormControl>
                                            <Input placeholder="e.g., Kerala" {...field} disabled={!isEditingClinic || isPending} />
                                          </FormControl>
                                          <FormMessage />
                                        </FormItem>
                                      )}/>
                                      <FormField control={clinicForm.control} name="pincode" render={({ field }) => (
                                        <FormItem>
                                          <FormLabel>Pincode <span className="text-destructive">*</span></FormLabel>
                                          <FormControl>
                                            <Input placeholder="e.g., 682016" {...field} disabled={!isEditingClinic || isPending} />
                                          </FormControl>
                                          <FormMessage />
                                        </FormItem>
                                      )}/>
                                    </div>
                                    <FormField control={clinicForm.control} name="mapsLink" render={({ field }) => (
                                        <FormItem><FormLabel>Google Maps Link</FormLabel><FormControl><Input {...field} disabled={!isEditingClinic || isPending} value={field.value || ''} /></FormControl><FormMessage /></FormItem>
                                    )}/>
                                    <FormItem>
                                        <FormLabel>Plan</FormLabel>
                                        <div><Badge>{clinicDetails?.plan || "Not set"}</Badge></div>
                                    </FormItem>

                                    {isEditingClinic && (
                                        <div className="flex justify-end gap-2 pt-4">
                                            <Button type="button" variant="ghost" onClick={handleCancelClinic} disabled={isPending}>Cancel</Button>
                                            <Button type="submit" disabled={isPending}>
                                                {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : <Save className="mr-2 h-4 w-4" />}
                                                Save Changes
                                            </Button>
                                        </div>
                                    )}
                                </CardContent>
                            </form>
                        </Form>
                  </Card>
              );
          case 'hours':
            return (
              <Card>
                {!clinicDetails ? <CardHeader><CardTitle>Loading...</CardTitle></CardHeader> : (
                  <>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle>Operating Hours</CardTitle>
                      {!isEditingHours && (
                          <Button variant="outline" size="icon" onClick={() => setIsEditingHours(true)} disabled={isPending}>
                              <Edit className="w-4 h-4"/>
                          </Button>
                      )}
                    </div>
                    <CardDescription>Manage your clinic's weekly schedule.</CardDescription>
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
                                    {isEditingHours && (
                                      <Button 
                                        type="button" 
                                        variant="ghost" 
                                        size="icon" 
                                        onClick={() => removeTimeSlot(dayIndex, slotIndex)}
                                        disabled={hour.timeSlots.length <= 1 || isPending}
                                      >
                                        <Trash2 className="h-4 w-4 text-destructive" />
                                      </Button>
                                    )}
                                  </div>
                                ))}
                                {isEditingHours && (
                                  <Button type="button" variant="link" size="sm" onClick={() => addTimeSlot(dayIndex)} className="text-primary" disabled={isPending}>
                                    <PlusCircle className="mr-2 h-4 w-4" /> Add Slot
                                  </Button>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </CardContent>
                      {isEditingHours && (
                          <CardFooter className="flex justify-end gap-2">
                              <Button type="button" variant="ghost" onClick={handleCancelHours} disabled={isPending}>Cancel</Button>
                              <Button type="submit" disabled={isPending}>
                                  {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : <Save className="mr-2 h-4 w-4" />}
                                  Save Hours
                              </Button>
                          </CardFooter>
                      )}
                    </form>
                  </Form>
                          </>
                      )}
                  </Card>
              );
          case 'settings':
            if (!clinicDetails) {
              return <Card><CardHeader><CardTitle>Loading Clinic Settings...</CardTitle></CardHeader></Card>;
            }
            return (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>Clinic Settings</CardTitle>
                    {!isEditingSettings && (
                      <Button variant="outline" size="icon" onClick={() => setIsEditingSettings(true)} disabled={isPending}>
                        <Edit className="w-4 h-4"/>
                      </Button>
                    )}
                  </div>
                  <CardDescription>Configure walk-in token allotment and skipped token recurrence settings.</CardDescription>
                </CardHeader>
                <Form {...settingsForm}>
                  <form onSubmit={settingsForm.handleSubmit(onSettingsSubmit)}>
                    <CardContent className="space-y-4">
                      <FormField
                        control={settingsForm.control}
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
                                disabled={!isEditingSettings || isPending}
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
                      <FormField
                        control={settingsForm.control}
                        name="skippedTokenRecurrence"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Skipped Token Recurrence</FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                min="1"
                                {...field}
                                onChange={e => field.onChange(parseInt(e.target.value, 10) || 1)}
                                disabled={!isEditingSettings || isPending}
                                value={field.value || ''}
                              />
                            </FormControl>
                            <FormDescription>
                              Number of active patients to skip before rejoining a skipped token to the queue.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      {isEditingSettings && (
                        <div className="flex justify-end gap-2 pt-4">
                          <Button type="button" variant="ghost" onClick={handleCancelSettings} disabled={isPending}>
                            Cancel
                          </Button>
                          <Button type="submit" disabled={isPending}>
                            {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : <Save className="mr-2 h-4 w-4" />}
                            Save Settings
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </form>
                </Form>
              </Card>
            );
          default:
              return null;
      }
  }

  return (
    <>
      <div>
        <ProfileHeader />
        <main className="flex-1 p-6 bg-background">
          <div className="max-w-6xl mx-auto grid md:grid-cols-4 gap-6 items-start">
            <div className="md:col-span-1">
                <Card>
                    <CardContent className="p-2">
                        <nav className="flex flex-col gap-1">
                            <Button variant={activeView === 'profile' ? 'secondary' : 'ghost'} className="w-full justify-start" onClick={() => setActiveView('profile')}>
                                <UserCircle className="mr-2 h-4 w-4"/>
                                Your Profile
                            </Button>
                            <Button variant={activeView === 'clinic' ? 'secondary' : 'ghost'} className="w-full justify-start" onClick={() => setActiveView('clinic')}>
                                <Building className="mr-2 h-4 w-4"/>
                                Clinic Details
                            </Button>
                            <Button variant={activeView === 'hours' ? 'secondary' : 'ghost'} className="w-full justify-start" onClick={() => setActiveView('hours')}>
                                <Clock className="mr-2 h-4 w-4"/>
                                Operating Hours
                            </Button>
                            <Button variant={activeView === 'settings' ? 'secondary' : 'ghost'} className="w-full justify-start" onClick={() => setActiveView('settings')}>
                                <Settings className="mr-2 h-4 w-4"/>
                                Settings
                            </Button>
                        </nav>
                    </CardContent>
                </Card>
            </div>
            <div className="md:col-span-3">
              {loading ? (
                <Card>
                  <CardContent className="p-10 flex items-center justify-center">
                    <Loader2 className="mr-2 h-6 w-6 animate-spin"/> Loading profile...
                  </CardContent>
                </Card>
              ) : renderContent()}
            </div>
          </div>
        </main>
      </div>
    </>
  );
}
