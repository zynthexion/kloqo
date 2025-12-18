

"use client";

import { useState, useTransition } from "react";
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { doc, setDoc, updateDoc, arrayUnion, collection, writeBatch, getDocs, query, where, serverTimestamp, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { Patient, User } from "@/lib/types";

const formSchema = z.object({
  name: z.string()
    .min(3, { message: "Name must be at least 3 characters." })
    .regex(/^[a-zA-Z\s]+$/, { message: "Name must contain only alphabets and spaces." })
    .refine(name => !name.startsWith(' ') && !name.endsWith(' ') && !name.includes('  '), {
      message: "Spaces are only allowed between letters, not at the start, end, or multiple consecutive spaces."
    }),
  age: z.preprocess(
    (val) => (val === "" || val === undefined || val === null ? undefined : Number(val)),
    z.number({ required_error: "Age is required.", invalid_type_error: "Age is required." })
      .min(1, { message: "Age must be a positive number above zero." })
      .max(120, { message: "Age must be less than 120." })
  ),
  sex: z.enum(["Male", "Female", "Other"], { required_error: "Please select a gender." }),
  phone: z.string()
    .optional()
    .refine((val) => {
      if (!val || val.length === 0) return true; // Optional field, empty is valid
      // Strip +91 prefix if present, then check for exactly 10 digits
      const cleaned = val.replace(/^\+91/, '').replace(/\D/g, ''); // Remove +91 and non-digits
      if (cleaned.length === 0) return false; // If all digits removed, invalid
      if (cleaned.length < 10) return false; // Less than 10 digits is invalid
      if (cleaned.length > 10) return false; // More than 10 digits is invalid
      return /^\d{10}$/.test(cleaned);
    }, {
      message: "Phone number must be exactly 10 digits."
    }),
  place: z.string().min(2, { message: "Location is required." }),
});

type AddRelativeFormValues = z.infer<typeof formSchema>;

type AddRelativeDialogProps = {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  primaryMemberId: string;
  onRelativeAdded: (newRelative: Patient) => void;
};

export function AddRelativeDialog({
  isOpen,
  setIsOpen,
  primaryMemberId,
  onRelativeAdded,
}: AddRelativeDialogProps) {
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();

  const form = useForm<AddRelativeFormValues>({
    resolver: zodResolver(formSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: {
      name: "",
      age: undefined,
      sex: undefined,
      phone: "",
      place: "",
    },
  });

  const onSubmit = (values: AddRelativeFormValues) => {
    startTransition(async () => {
      try {
        const batch = writeBatch(db);
        const newRelativePatientRef = doc(collection(db, "patients"));
        const primaryMemberRef = doc(db, "patients", primaryMemberId);

        const primaryMemberSnap = await getDoc(primaryMemberRef);
        if (!primaryMemberSnap.exists()) {
          toast({ variant: 'destructive', title: 'Error', description: 'Primary member not found.' });
          return;
        }
        const primaryMemberData = primaryMemberSnap.data() as Patient;
        const primaryMemberPhone = primaryMemberData.communicationPhone || primaryMemberData.phone;

        // Clean phone: remove +91 if user entered it, remove any non-digits, then ensure exactly 10 digits
        let relativePhone = "";
        if (values.phone) {
          const cleaned = values.phone.replace(/^\+91/, '').replace(/\D/g, ''); // Remove +91 prefix and non-digits
          if (cleaned.length === 10) {
            relativePhone = `+91${cleaned}`; // Add +91 prefix when saving
          }
        }

        // Check if the phone number matches primary patient's phone (duplicate check)
        const primaryPhone = primaryMemberData.phone || primaryMemberData.communicationPhone;
        const isDuplicatePhone = relativePhone && primaryPhone &&
          relativePhone.replace(/^\+91/, '') === primaryPhone.replace(/^\+91/, '');

        let newRelativeData: Patient;

        if (relativePhone && !isDuplicatePhone) {
          // Case 1: Relative HAS a unique phone number (not matching primary)
          // Check if phone is unique across ALL patients
          const patientsRef = collection(db, "patients");
          const patientPhoneQuery = query(patientsRef, where("phone", "==", relativePhone));
          const patientPhoneSnapshot = await getDocs(patientPhoneQuery);

          if (!patientPhoneSnapshot.empty) {
            toast({
              variant: "destructive",
              title: "Phone Number Already Exists",
              description: "This phone number is already registered to another patient.",
            });
            return;
          }

          // Check users collection as well
          const usersRef = collection(db, "users");
          const userQuery = query(usersRef, where("phone", "==", relativePhone));
          const userSnapshot = await getDocs(userQuery);

          if (!userSnapshot.empty) {
            toast({
              variant: "destructive",
              title: "Phone Number In Use",
              description: "This phone number is already registered to another user.",
            });
            return;
          }

          const newUserRef = doc(collection(db, 'users'));
          const newUserData: User = {
            uid: newUserRef.id,
            phone: relativePhone,
            role: 'patient',
            patientId: newRelativePatientRef.id
          };
          batch.set(newUserRef, newUserData);

          // If relative has phone, they become PRIMARY patient themselves
          newRelativeData = {
            id: newRelativePatientRef.id,
            primaryUserId: newUserRef.id, // Their own user ID since they're primary
            name: values.name,
            phone: relativePhone, // Set phone field
            communicationPhone: relativePhone, // Set communication phone
            place: values.place,
            isPrimary: true, // They become primary since they have a phone
            relatedPatientIds: [], // Empty array - they're primary, relatives will be added later
            totalAppointments: 0,
            visitHistory: [],
            clinicIds: primaryMemberData.clinicIds || [],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          } as any;

          // Only add age and sex if they have values (Firestore doesn't allow undefined)
          if (values.age !== undefined && values.age !== null) {
            newRelativeData.age = values.age;
          }
          if (values.sex) {
            newRelativeData.sex = values.sex;
          }

        } else {
          // Case 2: Relative does NOT have a phone number OR phone matches primary (duplicate)
          // If no phone provided or duplicate, leave 'phone' field empty and use primary's phone for communicationPhone
          newRelativeData = {
            id: newRelativePatientRef.id,
            name: values.name,
            phone: "", // Phone field is explicitly empty when no phone entered
            communicationPhone: primaryMemberPhone, // Use primary patient's communicationPhone (already prioritized communicationPhone || phone on line 84)
            place: values.place,
            isPrimary: false,
            totalAppointments: 0,
            visitHistory: [],
            // Relatives should NOT have relatedPatientIds - only primary patients have this field
            clinicIds: primaryMemberData.clinicIds || [],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          } as any;

          // Only add age and sex if they have values (Firestore doesn't allow undefined)
          if (values.age !== undefined && values.age !== null) {
            newRelativeData.age = values.age;
          }
          if (values.sex) {
            newRelativeData.sex = values.sex;
          }
        }

        // Remove undefined values - Firestore doesn't allow undefined
        const cleanedRelativeData = Object.fromEntries(
          Object.entries(newRelativeData).filter(([_, v]) => v !== undefined)
        );
        batch.set(newRelativePatientRef, cleanedRelativeData);

        // Always add to primary's relatedPatientIds, regardless of whether relative has a phone
        // Even if relative has a unique phone and becomes isPrimary: true, they are still a relative of the primary patient
        batch.update(primaryMemberRef, {
          relatedPatientIds: arrayUnion(newRelativePatientRef.id),
        });

        await batch.commit();

        onRelativeAdded(newRelativeData);

        toast({
          title: "Relative Added",
          description: `${values.name} has been added to the family.`,
        });
        setIsOpen(false);
        form.reset();
      } catch (error) {
        console.error("Error adding relative:", error);
        toast({
          variant: "destructive",
          title: "Error",
          description: "Failed to add relative. Please try again.",
        });
      }
    });
  };

  const handleOpenChange = (open: boolean) => {
    // Only close when explicitly requested (via Cancel or close button), not on outside click
    if (!open) {
      setIsOpen(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        onInteractOutside={(e) => {
          e.preventDefault(); // Prevent closing when clicking outside
        }}
        onEscapeKeyDown={(e) => {
          e.preventDefault(); // Prevent closing with ESC key - only close via Cancel or close button
        }}
      >
        <DialogHeader>
          <DialogTitle>Add New Relative</DialogTitle>
          <DialogDescription>
            Enter the details for the new family member.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Full Name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Enter full name"
                      {...field}
                      value={field.value || ''}
                      onBlur={field.onBlur}
                      onChange={(e) => {
                        field.onChange(e);
                        form.trigger('name');
                      }}
                    />
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
                    <FormLabel>Age</FormLabel>
                    <FormControl>
                      <Input
                        type="text"
                        inputMode="numeric"
                        placeholder="Enter the age"
                        {...field}
                        value={field.value?.toString() ?? ''}
                        onBlur={field.onBlur}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === '' || /^\d+$/.test(val)) {
                            field.onChange(val);
                            form.trigger('age');
                          }
                        }}
                        className="[&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [-moz-appearance:textfield]"
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
                    <FormLabel>Gender</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || ""}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select gender" />
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
            </div>
            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone Number (Optional)</FormLabel>
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
              name="place"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Place</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Enter city or town"
                      {...field}
                      value={field.value || ''}
                      onBlur={field.onBlur}
                      onChange={(e) => {
                        field.onChange(e);
                        form.trigger('place');
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setIsOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending || !form.formState.isValid}>
                {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Relative
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
