
"use client";

import { useState, useEffect, useTransition, useRef } from "react";
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
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Trash, Upload, Trash2, Edit, PlusCircle as PlusCircleIcon } from "lucide-react";
import type { Doctor, Department, AvailabilitySlot } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";
import { ScrollArea } from "../ui/scroll-area";
import Image from "next/image";
import { format, parse, addMinutes, isBefore } from "date-fns";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/firebase";
import { setDoc, doc, getDoc, collection, query, where, getDocs, updateDoc, arrayUnion } from "firebase/firestore";
import { db } from "@/lib/firebase";
import imageCompression from "browser-image-compression";
import { Textarea } from "../ui/textarea";
import { SelectDepartmentDialog } from "../onboarding/select-department-dialog";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

const timeSlotSchema = z.object({
  from: z.string().min(1, "Required"),
  to: z.string().min(1, "Required"),
}).refine(data => data.from < data.to, {
    message: "End time must be after start time.",
    path: ["to"],
});

const availabilitySlotSchema = z.object({
  day: z.string(),
  timeSlots: z.array(timeSlotSchema).min(1, "At least one time slot is required."),
}).refine(data => {
    const sortedSlots = [...data.timeSlots].sort((a, b) => a.from.localeCompare(b.from));
    for (let i = 0; i < sortedSlots.length - 1; i++) {
        if (sortedSlots[i].to > sortedSlots[i+1].from) {
            return false; // Overlap detected
        }
    }
    return true;
}, {
    message: "Time slots cannot overlap.",
    path: ["timeSlots"],
});

const formSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(2, { message: "Name must be at least 2 characters." }),
  specialty: z.string().min(2, { message: "Specialty must be at least 2 characters." }),
  department: z.string().min(1, { message: "Please select a department." }),
  registrationNumber: z.string().optional(),
  bio: z.string().optional(),
  experience: z.coerce.number().min(0, "Years of experience cannot be negative."),
  consultationFee: z.coerce.number({invalid_type_error: "Consultation fee is required."}).min(1, "Consultation fee must be greater than 0."),
  averageConsultingTime: z.coerce.number().min(5, "Must be at least 5 minutes."),
  availabilitySlots: z.array(availabilitySlotSchema).min(1, "At least one availability slot is required."),
  photo: z.any().optional(),
  freeFollowUpDays: z.coerce.number().min(0, "Cannot be negative.").optional(),
  advanceBookingDays: z.coerce.number().min(0, "Cannot be negative.").optional(),
});

type AddDoctorFormValues = z.infer<typeof formSchema>;

type AddDoctorFormProps = {
  onSave: (doctor: Doctor) => void;
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  doctor: Doctor | null;
  departments: Department[];
  updateDepartments: (newDepartment: Department) => void;
};

const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayAbbreviations = ["S", "M", "T", "W", "T", "F", "S"];

const generateTimeOptions = (startTime: string, endTime: string, interval: number): string[] => {
    const options = [];
    let currentTime = parse(startTime, "HH:mm", new Date());
    const end = parse(endTime, "HH:mm", new Date());

    while (isBefore(currentTime, end)) {
        options.push(format(currentTime, "HH:mm"));
        currentTime = addMinutes(currentTime, interval);
    }
    options.push(format(end, "HH:mm")); // Include the end time
    return options;
};

const defaultDoctorImage = "https://firebasestorage.googleapis.com/v0/b/kloqo-clinic-multi-33968-4c50b.firebasestorage.app/o/doctor.jpg?alt=media&token=1cee71fb-ab82-4392-ab24-0e0aecd8de84";


export function AddDoctorForm({ onSave, isOpen, setIsOpen, doctor, departments, updateDepartments }: AddDoctorFormProps) {
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const { toast } = useToast();
  const isEditMode = !!doctor;
  const auth = useAuth();
  const [isPending, startTransition] = useTransition();
  const [isSubmitting, setIsSubmitting] = useState(false); // Guard against duplicate submissions
  const submittingDocIdRef = useRef<string | null>(null); // Track which doctor ID is being submitted
  const [clinicId, setClinicId] = useState<string | null>(null);
  const [clinicDetails, setClinicDetails] = useState<any | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isSelectDepartmentOpen, setIsSelectDepartmentOpen] = useState(false);
  const [masterDepartments, setMasterDepartments] = useState<Department[]>([]);


  const [selectedDays, setSelectedDays] = useState<string[]>([]);
  const [sharedTimeSlots, setSharedTimeSlots] = useState<Array<{ from: string; to: string }>>([{ from: "09:00", to: "17:00" }]);

  const form = useForm<AddDoctorFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      specialty: "",
      department: "",
      registrationNumber: "",
      bio: "",
      experience: 0,
      consultationFee: undefined,
      averageConsultingTime: 5,
      availabilitySlots: [],
      freeFollowUpDays: 7,
      advanceBookingDays: 30,
    },
    mode: 'onBlur',
  });

  useEffect(() => {
    const fetchMasterDepartments = async () => {
      if (isSelectDepartmentOpen) {
        const masterDeptsSnapshot = await getDocs(collection(db, "master-departments"));
        const masterDeptsList = masterDeptsSnapshot.docs.map(d => d.data() as Department);
        setMasterDepartments(masterDeptsList);
      }
    };
    fetchMasterDepartments();
  }, [isSelectDepartmentOpen]);


  useEffect(() => {
    if (auth.currentUser) {
      const fetchClinicData = async () => {
        const userDocRef = doc(db, 'users', auth.currentUser!.uid);
        const userDocSnap = await getDoc(userDocRef);
        const userClinicId = userDocSnap.data()?.clinicId;
        if (userClinicId) {
          setClinicId(userClinicId);
          const clinicDocRef = doc(db, 'clinics', userClinicId);
          const clinicDocSnap = await getDoc(clinicDocRef);
          if (clinicDocSnap.exists()) {
            setClinicDetails(clinicDocSnap.data());
          }
        } else {
          console.error('Could not find clinicId for the current user.');
        }
      };
      fetchClinicData();
    }
  }, [auth.currentUser]);


  useEffect(() => {
    if (doctor) {
      const availabilitySlots = doctor.availabilitySlots?.map(s => ({
          ...s,
          timeSlots: s.timeSlots.map(ts => {
            try {
              return {
                from: format(parse(ts.from, 'hh:mm a', new Date()), 'HH:mm'),
                to: format(parse(ts.to, 'hh:mm a', new Date()), 'HH:mm')
              }
            } catch {
                return { from: ts.from, to: ts.to };
            }
          })
        })) || [];
      form.reset({
        id: doctor.id,
        name: doctor.name,
        specialty: doctor.specialty,
        department: doctor.department,
        registrationNumber: doctor.registrationNumber || "",
        bio: doctor.bio || "",
        experience: doctor.experience || 0,
        consultationFee: doctor.consultationFee,
        averageConsultingTime: doctor.averageConsultingTime || 5,
        availabilitySlots: availabilitySlots,
        freeFollowUpDays: doctor.freeFollowUpDays || 7,
        advanceBookingDays: doctor.advanceBookingDays || 30,
      });
      setPhotoPreview(doctor.avatar || defaultDoctorImage);
      if(availabilitySlots.length > 0) {
        setSharedTimeSlots(availabilitySlots[0].timeSlots);
      }
    } else {
      form.reset({
        name: "",
        specialty: "",
        department: "",
        registrationNumber: "",
        bio: "",
        experience: 0,
        consultationFee: undefined,
        averageConsultingTime: 5,
        availabilitySlots: [],
        freeFollowUpDays: 7,
        advanceBookingDays: 30,
      });
      setPhotoPreview(defaultDoctorImage);
      setSharedTimeSlots([{ from: "09:00", to: "17:00" }]);
    }
  }, [doctor, form, isOpen]);

  const watchedAvailabilitySlots = form.watch('availabilitySlots');

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
  
    // Check if slots are within clinic hours
    for (const day of selectedDays) {
      const clinicDay = clinicDetails?.operatingHours?.find((h: any) => h.day === day);
      if (!clinicDay || clinicDay.isClosed) {
          toast({ variant: "destructive", title: "Invalid Day", description: `Clinic is closed on ${day}.` });
          return;
      }
  
      for (const slot of validSharedTimeSlots) {
          let withinHours = false;
          for (const clinicSlot of clinicDay.timeSlots) {
              if (slot.from >= clinicSlot.open && slot.to <= clinicSlot.close) {
                  withinHours = true;
                  break;
              }
          }
          if (!withinHours) {
              toast({ variant: "destructive", title: "Invalid Time Slot", description: `Slot for ${day} is outside clinic operating hours.` });
              return;
          }
      }
    }
  
    const currentFormSlots = form.getValues('availabilitySlots') || [];
    const newSlotsMap = new Map<string, AvailabilitySlot>();
    
    currentFormSlots.forEach(slot => newSlotsMap.set(slot.day, slot));
  
    selectedDays.forEach(day => {
        newSlotsMap.set(day, { day, timeSlots: validSharedTimeSlots });
    });
  
    const updatedSlots = Array.from(newSlotsMap.values());
    
    form.setValue('availabilitySlots', updatedSlots, { shouldDirty: true, shouldValidate: true });
    
    toast({
        title: "Time Slots Applied",
        description: `The defined time slots have been applied to the selected days.`,
    });
    
    setSelectedDays([]);
  };

  const handleDepartmentsSelected = async (selectedDepts: Department[]) => {
    if (!auth.currentUser || !clinicId) return;

    try {
        const clinicRef = doc(db, "clinics", clinicId);
        const departmentIdsToAdd = selectedDepts.map(d => d.id);
        
        await updateDoc(clinicRef, {
            departments: arrayUnion(...departmentIdsToAdd)
        });
        
        // This assumes we only add one at a time from this flow.
        const newDept = selectedDepts[0];
        if (newDept) {
            updateDepartments(newDept);
            form.setValue('department', newDept.name, { shouldValidate: true });
        }

        toast({
            title: "Department Added",
            description: `${selectedDepts.length} department(s) have been successfully added.`,
        });
    } catch (error) {
        console.error("Error saving departments:", error);
        toast({
            variant: "destructive",
            title: "Error",
            description: "Failed to save departments. Please try again.",
        });
    }
  }


  const onSubmit = (values: AddDoctorFormValues) => {
    // Prevent duplicate submissions
    if (isSubmitting || isPending) {
      console.warn('Form submission already in progress, ignoring duplicate submit');
      return;
    }

    setIsSubmitting(true);
    startTransition(async () => {
      try {
        if (!auth.currentUser) {
          toast({ variant: "destructive", title: "Authentication Error", description: "You must be logged in to save a doctor." });
          setIsSubmitting(false);
          return;
        }

        if (!clinicId) {
          toast({ variant: "destructive", title: "Configuration Error", description: "Cannot save doctor without a valid clinic ID." });
          setIsSubmitting(false);
          return;
        }
        if (!isEditMode) {
            const clinicDocRef = doc(db, "clinics", clinicId);
            const clinicDocSnap = await getDoc(clinicDocRef);
    
            if (clinicDocSnap.exists()) {
              const clinicData = clinicDocSnap.data();
              const maxDoctors = clinicData.numDoctors || 1;
              const doctorsQuery = query(collection(db, "doctors"), where("clinicId", "==", clinicId));
              const doctorsSnapshot = await getDocs(doctorsQuery);
              const currentDoctorCount = doctorsSnapshot.size;
    
              if (currentDoctorCount >= maxDoctors) {
                toast({
                  variant: "destructive",
                  title: "Doctor Limit Reached",
                  description: `Your plan allows for ${maxDoctors} doctor(s). To add more, please upgrade your plan.`,
                  duration: 6000
                });
                setIsSubmitting(false);
                return;
              }
            }
        }
        
        // Handle photo URL: for edit mode, preserve existing; for new doctors, only set if photo uploaded
        let photoUrl: string = defaultDoctorImage; // Always initialize with default
        const photoFile = form.getValues('photo');

        if (isEditMode) {
            // In edit mode, preserve existing avatar or use default
            photoUrl = doctor?.avatar || defaultDoctorImage;
        }

        if (photoFile instanceof File) {
            console.log("New photo file detected:", photoFile.name, `(${(photoFile.size / 1024).toFixed(2)} KB)`);
            try {
                const options = {
                    maxSizeMB: 0.5,
                    maxWidthOrHeight: 800,
                    useWebWorker: true,
                };

                console.log("Compressing image...");
                const compressedFile = await imageCompression(photoFile, options);
                console.log("Image compressed:", compressedFile.name, `(${(compressedFile.size / 1024).toFixed(2)} KB)`);
                
                const formData = new FormData();
                formData.append('file', compressedFile);
                formData.append('clinicId', clinicId);
                formData.append('userId', auth.currentUser.uid);

                console.log("Uploading image via API...");
                const response = await fetch('/api/upload-avatar', {
                    method: 'POST',
                    body: formData,
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.error || 'Upload failed');
                }

                const data = await response.json();
                photoUrl = data.url; // Override with uploaded URL
                console.log("File uploaded successfully. URL:", photoUrl);
                
            } catch (uploadError: any) {
                console.error("Upload error:", uploadError);
                toast({
                    variant: "destructive",
                    title: "Upload Failed",
                    description: uploadError.message,
                });
                setIsSubmitting(false);
                return;
            }
        }
        // If no photo uploaded and not edit mode, photoUrl remains as defaultDoctorImage (already set)

        const scheduleString = values.availabilitySlots
          ?.sort((a, b) => daysOfWeek.indexOf(a.day) - daysOfWeek.indexOf(b.day))
          .map(slot => `${slot.day}: ${slot.timeSlots.map(ts => `${format(parse(ts.from, "HH:mm", new Date()), "hh:mm a")}-${format(parse(ts.to, "HH:mm", new Date()), "hh:mm a")}`).join(', ')}`)
          .join('; ');

        // Generate unique ID: use existing ID for edit mode, or generate a unique one for new doctors
        // Use a combination of timestamp and random to avoid collisions
        let docId = values.id || (isEditMode && doctor?.id ? doctor.id : `doc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
        
        // Prevent duplicate submission for the same doctor ID
        if (submittingDocIdRef.current === docId) {
          console.warn('Duplicate submission prevented for doctor ID:', docId);
          setIsSubmitting(false);
          return;
        }
        
        submittingDocIdRef.current = docId;
        
        // For new doctors, check if this ID already exists (safety check for duplicates)
        if (!isEditMode) {
          const existingDocRef = doc(db, "doctors", docId);
          const existingDocSnap = await getDoc(existingDocRef);
          if (existingDocSnap.exists()) {
            // If by chance the ID exists, generate a new one
            docId = `doc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            submittingDocIdRef.current = docId; // Update the ref with new ID
          }
        }

        const doctorToSave: Doctor = {
          id: docId,
          clinicId: clinicId,
          name: values.name,
          specialty: values.specialty,
          department: values.department,
          registrationNumber: values.registrationNumber,
          avatar: photoUrl,
          schedule: scheduleString || "Not set",
          preferences: doctor?.preferences || 'Not set',
          historicalData: doctor?.historicalData || 'No data',
          availability: doctor?.availability || 'Unavailable',
          consultationStatus: isEditMode ? doctor.consultationStatus : 'Out',
          bio: values.bio,
          experience: values.experience,
          consultationFee: values.consultationFee,
          averageConsultingTime: values.averageConsultingTime,
          availabilitySlots: values.availabilitySlots.map(s => ({
            ...s, timeSlots: s.timeSlots.map(ts => ({
              from: format(parse(ts.from, "HH:mm", new Date()), "hh:mm a"),
              to: format(parse(ts.to, "HH:mm", new Date()), "hh:mm a")
            }))
          })),
          freeFollowUpDays: values.freeFollowUpDays,
          advanceBookingDays: values.advanceBookingDays,
        };

        await setDoc(doc(db, "doctors", docId), doctorToSave, { merge: true });

        // Update currentDoctorCount in clinic document if this is a new doctor
        if (!isEditMode) {
          try {
            const clinicRef = doc(db, "clinics", clinicId);
            const clinicDoc = await getDoc(clinicRef);
            const currentCount = clinicDoc.data()?.currentDoctorCount || 0;
            await updateDoc(clinicRef, {
              currentDoctorCount: currentCount + 1
            });
          } catch (error) {
            console.error("Error updating currentDoctorCount:", error);
            // Don't fail the doctor save if this update fails
          }
        }

        onSave(doctorToSave);
        setIsOpen(false);
        form.reset();
        setPhotoPreview(null);
        setIsSubmitting(false);
        submittingDocIdRef.current = null; // Clear the ref after successful save
        toast({
          title: `Doctor ${isEditMode ? "Updated" : "Added"}`,
          description: `${values.name} has been successfully ${isEditMode ? "updated" : "added"}.`,
        });

      } catch (error: any) {
        setIsSubmitting(false);
        submittingDocIdRef.current = null; // Clear the ref on error
        console.error("An error occurred during form submission:", error);
        toast({
          variant: "destructive",
          title: "Save Failed",
          description: error.message || "An unexpected error occurred. Please check the console.",
        });
      }
    });
  };

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    console.log("File selected:", file);
    if (file) {
      if (!file.type.startsWith('image/')) {
        toast({
          variant: "destructive",
          title: "Invalid file type",
          description: "Please select an image file.",
        });
        return;
      }

      if (file.size > 5 * 1024 * 1024) {
        toast({
          variant: "destructive",
          title: "File too large",
          description: "Please select an image smaller than 5MB.",
        });
        return;
      }

      form.setValue('photo', file);
      const previewUrl = URL.createObjectURL(file);
      console.log("Generated preview URL:", previewUrl);
      setPhotoPreview(previewUrl);
    }
  };

  const handlePhotoDelete = () => {
    form.setValue('photo', null);
    setPhotoPreview(defaultDoctorImage);
    if(fileInputRef.current) {
        fileInputRef.current.value = "";
    }
  }

  const availableMasterDepartments = masterDepartments.filter(
    (masterDept) => !departments.some((clinicDept) => clinicDept.id === masterDept.id)
  );

  const isDepartmentLimitReached = clinicDetails ? departments.length >= clinicDetails.numDoctors : false;


  return (
    <>
    <Dialog open={isOpen} onOpenChange={(open) => {
        if (!open) {
           setIsOpen(false);
           setIsSubmitting(false); // Reset submission state when dialog closes
           submittingDocIdRef.current = null; // Clear the ref when dialog closes
        }
    }}>
      <DialogContent 
        className="max-w-4xl"
        onInteractOutside={(e) => {
          e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{isEditMode ? "Edit Doctor" : "Add New Doctor"}</DialogTitle>
          <DialogDescription>
            {isEditMode ? "Update the details for this doctor." : "Fill in the details below to add a new doctor to the system."}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <ScrollArea className="h-[60vh] p-1">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-4">
                {/* Left Column */}
                <div className="space-y-4">
                  <FormItem>
                    <FormLabel>Doctor's Photo</FormLabel>
                     <div className="flex items-center gap-4">
                        <div className="w-24 h-24 rounded-full bg-muted flex items-center justify-center overflow-hidden">
                          {photoPreview ? (
                            <Image src={photoPreview} alt="Doctor's Photo" width={96} height={96} className="object-cover w-full h-full" />
                          ) : (
                            <Upload className="w-8 h-8 text-muted-foreground" />
                          )}
                        </div>
                        <div className="flex flex-col gap-2">
                           <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()}>
                              <Edit className="mr-2 h-4 w-4" />
                              Change
                            </Button>
                            <Button type="button" variant="destructive" size="sm" onClick={handlePhotoDelete}>
                               <Trash2 className="mr-2 h-4 w-4" />
                               Delete
                            </Button>
                        </div>
                        <FormControl>
                            <Input type="file" accept="image/*" onChange={handlePhotoChange} className="hidden" id="photo-upload" ref={fileInputRef} />
                        </FormControl>
                      </div>
                    <FormMessage />
                  </FormItem>
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center gap-1">
                          Name
                          <span className="text-red-500">*</span>
                        </FormLabel>
                        <FormControl>
                          <Input placeholder="Dr. John Doe" {...field} value={field.value ?? ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                   <FormField
                    control={form.control}
                    name="registrationNumber"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Registration Number</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g., IMA/12345" {...field} value={field.value ?? ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="specialty"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center gap-1">
                          Specialty
                          <span className="text-red-500">*</span>
                        </FormLabel>
                        <FormControl>
                          <Input placeholder="Cardiology" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="department"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center gap-1">
                          Department
                          <span className="text-red-500">*</span>
                        </FormLabel>
                        <Select onValueChange={(value) => {
                            if (value === 'add_new') {
                                if (isDepartmentLimitReached) {
                                    toast({
                                        variant: "destructive",
                                        title: "Department Limit Reached",
                                        description: "Please upgrade your plan to add more departments.",
                                    });
                                    return;
                                }
                                setIsSelectDepartmentOpen(true);
                            } else {
                                field.onChange(value);
                            }
                        }} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select a department" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {departments.map(dept => (
                              <SelectItem key={dept.id} value={dept.name}>
                                {dept.name}
                              </SelectItem>
                            ))}
                            <Separator />
                            <SelectItem value="add_new" className="text-primary focus:bg-primary/10 focus:text-primary">
                                <div className="flex items-center gap-2">
                                    <PlusCircleIcon className="h-4 w-4" />
                                    Add New Department
                                </div>
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="bio"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Bio
                        </FormLabel>
                        <FormControl>
                          <Textarea placeholder="A brief biography of the doctor..." {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="experience"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center gap-1">
                          Years of Experience
                          <span className="text-red-500">*</span>
                        </FormLabel>
                        <FormControl>
                          <Input type="number" min="0" placeholder="e.g., 10" {...field} value={field.value !== undefined ? field.value : ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="consultationFee"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center gap-1">
                          Consultation Fee (₹)
                          <span className="text-red-500">*</span>
                        </FormLabel>
                        <FormControl>
                          <Input type="number" min="0" placeholder="e.g., 150" {...field} value={field.value !== undefined ? field.value : ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="averageConsultingTime"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center gap-1">
                          Average Consulting Time (minutes)
                          <span className="text-red-500">*</span>
                        </FormLabel>
                        <FormControl>
                          <Input type="number" min="5" placeholder="e.g., 15" {...field} value={field.value !== undefined ? field.value : ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                   <FormField
                    control={form.control}
                    name="freeFollowUpDays"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Free Follow-up Period (Days)</FormLabel>
                        <FormControl>
                          <Input type="number" min="0" placeholder="e.g., 7" {...field} value={field.value !== undefined ? field.value : ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                   <FormField
                    control={form.control}
                    name="advanceBookingDays"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Advance Booking (Days)</FormLabel>
                        <FormControl>
                          <Input type="number" min="0" placeholder="e.g., 30" {...field} value={field.value !== undefined ? field.value : ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Right Column */}
                <div className="space-y-4">
                  <FormField
                    control={form.control}
                    name="availabilitySlots"
                    render={({ field }) => (
                      <FormItem>
                         <div className="mb-4">
                           <FormLabel className="text-base flex items-center gap-1">
                             Weekly Availability
                             <span className="text-red-500">*</span>
                           </FormLabel>
                           <FormDescription>
                             Define the doctor's recurring weekly schedule.
                           </FormDescription>
                           <FormMessage />
                         </div>
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
                                const dayForSlot = selectedDays[0] || daysOfWeek.find(day => !clinicDetails?.operatingHours?.find((h:any) => h.day === day)?.isClosed);
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
                                    .sort((a,b) => a.from.localeCompare(b.from))[0]?.from || clinicClosingTime;
                                
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
                                   <Button type="button" variant="ghost" size="icon" onClick={() => setSharedTimeSlots(prev => prev.filter((_, i) => i !== index))} disabled={sharedTimeSlots.length <=1}>
                                        <Trash className="h-4 w-4 text-red-500" />
                                   </Button>
                                </div>
                            )})}
                            <Button type="button" size="sm" variant="outline" onClick={() => setSharedTimeSlots(prev => [...prev, { from: "", to: "" }])}>
                                Add Another Slot
                            </Button>
                          </div>
                          
                          <Button type="button" className="w-full" onClick={applySharedSlotsToSelectedDays}>
                            3. Apply to Selected Days
                          </Button>

                          <div className="space-y-2 pt-4">
                            <Label>Review and save</Label>
                            <div className="space-y-3 rounded-md border p-3 min-h-[100px]">
                                {field.value && field.value.length > 0 ? (
                                    [...field.value]
                                    .sort((a, b) => daysOfWeek.indexOf(a.day) - daysOfWeek.indexOf(b.day))
                                    .map((fieldItem, index) => (
                                        <div key={index} className="text-sm">
                                            <p className="font-semibold">{fieldItem.day}</p>
                                            <div className="flex flex-wrap gap-1 mt-1">
                                            {fieldItem.timeSlots.map((ts, i) => {
                                                if (!ts.from || !ts.to) return null;
                                                return (
                                                    <Badge key={i} variant="secondary" className="font-normal">
                                                    {format(parse(ts.from, 'HH:mm', new Date()), 'p')} - {format(parse(ts.to, 'HH:mm', new Date()), 'p')}
                                                    </Badge>
                                                );
                                            })}
                                            </div>
                                        </div>
                                    ))
                                ) : (
                                    <p className="text-xs text-muted-foreground text-center pt-6">No availability applied yet.</p>
                                )}
                            </div>
                          </div>
                      </FormItem>
                    )}
                  />
                </div>
              </div>
            </ScrollArea>
            <DialogFooter className="pt-4">
              <Button type="button" variant="ghost" onClick={() => {
                setIsOpen(false);
                setIsSubmitting(false); // Reset submission state when cancelled
              }}>Cancel</Button>
              <Button
                type="submit"
                disabled={isPending || isSubmitting || !form.formState.isValid}
              >
                {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isEditMode ? "Save Changes" : "Save Doctor"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
    <SelectDepartmentDialog
        isOpen={isSelectDepartmentOpen}
        setIsOpen={setIsSelectDepartmentOpen}
        departments={availableMasterDepartments}
        onDepartmentsSelect={handleDepartmentsSelected}
        limit={clinicDetails?.numDoctors}
        currentCount={departments.length}
    />
    </>
  );
}

    