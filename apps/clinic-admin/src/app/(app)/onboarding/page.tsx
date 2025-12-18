
"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { AddDepartmentStep } from "@/components/onboarding/add-department-step";
import type { Department, Doctor } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { AddDoctorForm } from "@/components/doctors/add-doctor-form";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/firebase";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { db, storage } from "@/lib/firebase";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { errorEmitter } from "@/firebase/error-emitter";
import { FirestorePermissionError } from "@/firebase/errors";

export default function OnboardingPage() {
  const [step, setStep] = useState(1);
  const [selectedDepartments, setSelectedDepartments] = useState<Department[]>([]);
  const [isAddDoctorOpen, setIsAddDoctorOpen] = useState(false);
  const router = useRouter();
  const auth = useAuth();
  const { toast } = useToast();

  const handleDepartmentsAdded = useCallback((departments: Department[]) => {
    setSelectedDepartments(departments);
  }, []);

  const handleAddDoctorClick = useCallback(() => {
    setIsAddDoctorOpen(true);
  }, []);

  const handleSaveDoctor = async (doctorData: Omit<Doctor, 'id' | 'avatar' | 'schedule' | 'preferences' | 'historicalData' | 'clinicId'> & { photo?: File; id?: string }) => {
    if (!auth.currentUser) {
      toast({ variant: "destructive", title: "Authentication Error", description: "You must be logged in." });
      return;
    }

    const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
    const clinicId = userDoc.data()?.clinicId;
    if (!clinicId) {
      toast({ variant: "destructive", title: "Clinic not found", description: "This user is not associated with a clinic." });
      return;
    }

    let photoUrl = `https://picsum.photos/seed/new-doc-${Date.now()}/100/100`;
    if (doctorData.photo instanceof File) {
      const storageRef = ref(storage, `doctor_avatars/${Date.now()}_${doctorData.photo.name}`);
      await uploadBytes(storageRef, doctorData.photo);
      photoUrl = await getDownloadURL(storageRef);
    }

    const docId = `doc-${Date.now()}`;
    const newDoctor: Doctor = {
      id: docId,
      clinicId: clinicId,
      name: doctorData.name,
      specialty: doctorData.specialty,
      avatar: photoUrl,
      schedule: 'Not set',
      preferences: 'Not set',
      historicalData: 'No data',
      department: doctorData.department,
      availability: 'Available',
      bio: doctorData.bio,
      averageConsultingTime: doctorData.averageConsultingTime,
      availabilitySlots: doctorData.availabilitySlots,
      experience: doctorData.experience,
      consultationFee: doctorData.consultationFee,
    };

    const docRef = doc(db, "doctors", docId);
    const clinicRef = doc(db, 'clinics', clinicId);

    try {
      await setDoc(docRef, newDoctor);
      await updateDoc(clinicRef, { onboardingStatus: "Completed" });

      toast({
        title: "First Doctor Added!",
        description: "Onboarding complete. Welcome to your dashboard!",
      });

      setIsAddDoctorOpen(false);
      router.push('/dashboard');

    } catch (serverError) {
      const permissionError = new FirestorePermissionError({
        path: docRef.path,
        operation: 'create',
        requestResourceData: newDoctor,
      });
      errorEmitter.emit('permission-error', permissionError);
    }
  };

  const handleCompletion = async () => {
    if (!auth.currentUser) return;
    const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
    const clinicId = userDoc.data()?.clinicId;

    if (!clinicId) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Could not find clinic to finalize onboarding."
      });
      return;
    }

    const clinicRef = doc(db, 'clinics', clinicId);

    try {
      await updateDoc(clinicRef, { onboardingStatus: "Completed" });
      router.push('/dashboard');
      toast({
        title: "Onboarding Complete!",
        description: "Welcome to your dashboard."
      });
    } catch (error) {
      console.error("Failed to update onboarding status: ", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Could not finalize onboarding. Please try again."
      })
    }
  }

  return (
    <>
      <main className="flex-1 p-4 sm:p-6">
        <AddDepartmentStep onDepartmentsAdded={handleDepartmentsAdded} onAddDoctorClick={handleAddDoctorClick} />
      </main>

      <AddDoctorForm
        onSave={handleSaveDoctor as any}
        isOpen={isAddDoctorOpen}
        setIsOpen={setIsAddDoctorOpen}
        doctor={null}
        departments={selectedDepartments}
        updateDepartments={() => { }}
      />
    </>
  );
}
