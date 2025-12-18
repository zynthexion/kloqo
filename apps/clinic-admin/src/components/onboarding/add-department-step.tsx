
"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { PlusCircle } from "lucide-react";
import { SelectDepartmentDialog } from "./select-department-dialog";
import type { Department } from "@/lib/types";
import Image from "next/image";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/firebase";
import { doc, setDoc, getDoc, collection, writeBatch, getDocs, query, where, updateDoc, arrayUnion, arrayRemove } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Skeleton } from "../ui/skeleton";
import { FirestorePermissionError } from "@/firebase/errors";
import { errorEmitter } from "@/firebase/error-emitter";
import * as Lucide from "lucide-react";

const Pregnant = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 16.5a2.5 2.5 0 1 1-5 0c0-4.5 5-10.5 5-10.5s5 6 5 10.5a2.5 2.5 0 1 1-5 0Z" />
    <path d="M10 16.5a2.5 2.5 0 1 0-5 0c0-4.5-5-10.5-5-10.5s5 6 5 10.5a2.5 2.5 0 1 0-5 0Z" />
    <path d="M8 8a4 4 0 1 0 8 0c0-2.5-4-6-4-6s-4 3.5-4 6Z" />
  </svg>
);

const Tooth = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20.3 13.4c.5-1 .5-2.2.1-3.2-.4-1-1.2-1.8-2.2-2.2-.9-.4-2-.5-3-.1-1.1.4-2.1 1.2-2.7 2.2-.6-1-1.6-1.8-2.7-2.2-1.1-.4-2.1-.2-3 .1-1 .4-1.8 1.2-2.2 2.2-.4 1-.4 2.2.1 3.2.5 1 1.2 1.8 2.2 2.2.9.4 2 .5 3 .1 1.1-.4 2.1-1.2 2.7-2.2.6 1 1.6 1.8 2.7 2.2 1 .4 2.1.2 3-.1 1-.4 1.8-1.2 2.2-2.2Z" />
    <path d="m18 13-1.5-3.5" />
    <path d="m6 13 1.5-3.5" />
    <path d="M12 18.5V22" />
    <path d="M9.5 15.5s-1-2-2-2" />
    <path d="M14.5 15.5s1-2 2-2" />
  </svg>
);

const iconMap: Record<string, Lucide.LucideIcon | React.FC> = {
  ...Lucide,
  Pregnant,
  Tooth,
};

const DynamicIcon = ({ name, className }: { name: string, className: string }) => {
  const IconComponent = iconMap[name] || Lucide.Stethoscope;
  return <IconComponent className={className} />;
};


export function AddDepartmentStep({ onDepartmentsAdded, onAddDoctorClick }: { onDepartmentsAdded: (departments: Department[]) => void, onAddDoctorClick: () => void }) {
  const auth = useAuth();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [clinicDepartments, setClinicDepartments] = useState<Department[]>([]);
  const [masterDepartments, setMasterDepartments] = useState<Department[]>([]);
  const [clinicDetails, setClinicDetails] = useState<any>(null);
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!auth.currentUser) {
      setLoading(false);
      return;
    }

    const fetchInitialData = async () => {
      if (masterDepartments.length > 0 && clinicDetails) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const masterDeptsSnapshot = await getDocs(collection(db, "master-departments"));
        const masterDeptsList = masterDeptsSnapshot.docs.map(d => d.data() as Department);
        setMasterDepartments(masterDeptsList);

        const userDoc = await getDoc(doc(db, "users", auth.currentUser!.uid));
        if (!userDoc.exists()) {
          setLoading(false);
          return;
        }

        const clinicId = userDoc.data()?.clinicId;
        if (clinicId) {
          const clinicDoc = await getDoc(doc(db, "clinics", clinicId));
          if (clinicDoc.exists()) {
            const clinicData = clinicDoc.data();
            setClinicDetails(clinicData);
            const departmentIds: string[] = clinicData.departments || [];

            if (departmentIds.length > 0) {
              const depts = masterDeptsList.filter(masterDept => departmentIds.includes(masterDept.id));
              setClinicDepartments(depts);
              onDepartmentsAdded(depts);
              onAddDoctorClick();
            }
          }
        }
      } catch (error) {
        console.error("Error fetching initial department data:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchInitialData();
  }, [auth.currentUser, onDepartmentsAdded, onAddDoctorClick]);


  const handleSelectDepartments = useCallback(async (selectedDepts: Department[]) => {
    if (!auth.currentUser) {
      toast({ variant: "destructive", title: "Error", description: "You must be logged in." });
      return;
    }
    const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
    const clinicId = userDoc.data()?.clinicId;
    if (!clinicId) {
      toast({ variant: "destructive", title: "Error", description: "No clinic ID found for user." });
      return;
    }

    const clinicRef = doc(db, "clinics", clinicId);
    const departmentIdsToAdd = selectedDepts.map(d => d.id);

    updateDoc(clinicRef, {
      departments: arrayUnion(...departmentIdsToAdd)
    })
      .then(() => {
        const allDepts = [...clinicDepartments, ...selectedDepts].reduce((acc, current) => {
          if (!acc.find(item => item.id === current.id)) {
            acc.push(current);
          }
          return acc;
        }, [] as Department[]);

        setClinicDepartments(allDepts);
        onDepartmentsAdded(allDepts);

        toast({
          title: "Departments Added",
          description: `${selectedDepts.length} department(s) have been added to your clinic.`,
        });
      })
      .catch((serverError) => {
        console.error("Error updating clinic with departments:", serverError);
        const permissionError = new FirestorePermissionError({
          path: `/clinics/${clinicId}`,
          operation: 'update',
          requestResourceData: { departments: departmentIdsToAdd },
        });
        errorEmitter.emit('permission-error', permissionError);
      });
  }, [auth.currentUser, clinicDepartments, onDepartmentsAdded, toast]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center w-full max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-2">Select your initial departments</h1>
        <p className="text-muted-foreground mb-6">
          Add one or more departments to your clinic to begin using the application.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 w-full mt-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }

  const availableMasterDepartments = masterDepartments.filter(
    (masterDept) => !clinicDepartments.some((clinicDept) => clinicDept.id === masterDept.id)
  );

  return (
    <div className="flex flex-col items-center justify-center h-full text-center w-full">
      {clinicDepartments.length === 0 ? (
        <>
          <h1 className="text-2xl font-bold mb-2">Select your initial departments</h1>
          <p className="text-muted-foreground mb-6">
            Add one or more departments to your clinic to begin using the application.
          </p>
          <Button size="lg" onClick={() => setIsDialogOpen(true)}>
            <PlusCircle className="mr-2 h-5 w-5" />
            Add Departments
          </Button>
        </>
      ) : (
        <div className="w-full max-w-4xl">
          <div className="mb-8">
            <div className="bg-green-100 border-l-4 border-green-500 text-green-700 p-4 rounded-md mb-6 text-left w-full">
              <p className="font-bold">Departments Added!</p>
              <p>You have successfully added departments. The next step is to add doctors.</p>
            </div>
            <h2 className="text-xl font-semibold text-left mb-4">Your Departments ({clinicDepartments.length})</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {clinicDepartments.map((dept) => (
                <Card key={dept.id} className="text-left overflow-hidden">
                  <div className="h-32 w-full flex items-center justify-center bg-muted/30">
                    <DynamicIcon name={dept.icon} className="w-16 h-16 text-muted-foreground opacity-50" />
                  </div>
                  <CardContent className="p-4">
                    <p className="font-semibold">{dept.name}</p>
                    <p className="text-xs text-muted-foreground">{dept.description}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          <div className="flex flex-col items-center gap-4">
            <h1 className="text-2xl font-bold">Next Step: Add a Doctor</h1>
            <p className="text-muted-foreground">
              With your department set up, it's time to add a doctor to the system.
            </p>
            <div className="flex items-center gap-4">
              <Button size="lg" onClick={onAddDoctorClick}>
                <PlusCircle className="mr-2 h-5 w-5" />
                Add Doctor
              </Button>
              <Button variant="outline" onClick={() => setIsDialogOpen(true)}>
                <PlusCircle className="mr-2 h-4 w-4" />
                Add Additional Departments
              </Button>
            </div>
          </div>
        </div>
      )}

      <SelectDepartmentDialog
        isOpen={isDialogOpen}
        setIsOpen={setIsDialogOpen}
        departments={availableMasterDepartments}
        onDepartmentsSelect={handleSelectDepartments}
        limit={clinicDetails?.numDoctors}
        currentCount={clinicDepartments.length}
      />
    </div>
  );
}
