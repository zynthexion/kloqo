
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

  const handleSaveDoctor = async (doctor: Doctor) => {
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

    const clinicRef = doc(db, 'clinics', clinicId);

    try {
      await updateDoc(clinicRef, { onboardingStatus: "Completed" });

      toast({
        title: "First Doctor Added!",
        description: "Onboarding complete. Welcome to your dashboard!",
      });

      setIsAddDoctorOpen(false);
      router.push('/dashboard');

    } catch (serverError) {
      console.error("Error finalizing onboarding:", serverError);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Doctor was added, but failed to complete onboarding status. Please contact support.",
      });
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
