
"use client";

import Image from "next/image";
import {
  Card,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ChevronLeft,
  ChevronRight,
  PlusCircle,
  MoreHorizontal,
  Trash,
  Search,
  Users,
  Stethoscope,
  HeartPulse,
  Baby,
  Sparkles,
  BrainCircuit,
  Bone,
  Award,
  Droplets,
  Filter,
  Droplet,
  Eye,
  Ear,
  Brain,
  PersonStanding,
  Radiation,
  Siren,
  Microwave,
  TestTube,
  Bug,
  Scissors,
  Ambulance,
  Wind,
  type LucideIcon,
} from "lucide-react";
import * as Lucide from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { Department, Doctor } from "@/lib/types";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { collection, getDocs, doc, getDoc, updateDoc, arrayUnion, arrayRemove, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useToast } from "@/hooks/use-toast";
import { SelectDepartmentDialog } from "@/components/onboarding/select-department-dialog";
import { useAuth } from "@/firebase";
import { DepartmentDoctorsDialog } from "@/components/departments/department-doctors-dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

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


const iconMap: Record<string, LucideIcon | React.FC> = {
  Stethoscope, HeartPulse, Baby, Sparkles, BrainCircuit, Bone, Award, Droplets, Filter, Droplet, Eye, Ear, Brain, PersonStanding, Radiation, Siren, Microwave, TestTube, Bug, Scissors, Ambulance, Wind, Pregnant, Tooth
};

const DynamicIcon = ({ name, className }: { name: string, className: string }) => {
  const IconComponent = iconMap[name] || Stethoscope;
  return <IconComponent className={className} />;
};


export default function DepartmentsPage() {
  const auth = useAuth();
  const [clinicDepartments, setClinicDepartments] = useState<Department[]>([]);
  const [masterDepartments, setMasterDepartments] = useState<Department[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const { toast } = useToast();
  const [isAddDepartmentOpen, setIsAddDepartmentOpen] = useState(false);
  const [deletingDepartment, setDeletingDepartment] = useState<Department | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewingDoctorsDept, setViewingDoctorsDept] = useState<Department | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [departmentsPerPage, setDepartmentsPerPage] = useState(8);
  const [clinicDetails, setClinicDetails] = useState<any>(null);

  const filteredDepartments = useMemo(() => {
    return clinicDepartments.filter(department =>
      department.name.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [clinicDepartments, searchTerm]);

  const totalPages = Math.ceil(filteredDepartments.length / departmentsPerPage);
  const currentDepartments = filteredDepartments.slice(
    (currentPage - 1) * departmentsPerPage,
    currentPage * departmentsPerPage
  );

  useEffect(() => {
    const fetchMasterDepartments = async () => {
      if (!auth.currentUser) return;
      try {
        const masterDeptsSnapshot = await getDocs(collection(db, "master-departments"));
        const masterDeptsList = masterDeptsSnapshot.docs.map(d => d.data() as Department);
        setMasterDepartments(masterDeptsList);
      } catch (error) {
        console.error("Error fetching master departments:", error);
        toast({ variant: "destructive", title: "Error", description: "Could not load master department list." });
      }
    };
    fetchMasterDepartments();
  }, [auth.currentUser, toast]);

  const fetchClinicData = useCallback(async () => {
    if (!auth.currentUser) return;
    setLoading(true);
    try {
      const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
      const clinicId = userDoc.data()?.clinicId;

      if (clinicId) {
        const clinicDoc = await getDoc(doc(db, "clinics", clinicId));
        if (clinicDoc.exists()) {
          const clinicData = clinicDoc.data();
          setClinicDetails(clinicData);
          const departmentIds: string[] = clinicData.departments || [];

          if (departmentIds.length > 0) {
            const departmentPromises = departmentIds.map(id => getDoc(doc(db, 'master-departments', id)));
            const departmentSnapshots = await Promise.all(departmentPromises);
            const deptsForClinic = departmentSnapshots
              .filter(snap => snap.exists())
              .map(snap => snap.data() as Department);
            setClinicDepartments(deptsForClinic);
          } else {
            setClinicDepartments([]);
          }
        }
        const doctorsSnapshot = await getDocs(query(collection(db, "doctors"), where("clinicId", "==", clinicId)));
        const doctorsList = doctorsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Doctor));
        setDoctors(doctorsList);
      }
    } catch (error) {
      console.error("Error fetching departments data:", error);
      toast({ variant: "destructive", title: "Error", description: "Failed to load clinic-specific department data." });
    } finally {
      setLoading(false);
    }
  }, [auth.currentUser, toast]);

  useEffect(() => {
    fetchClinicData();
  }, [fetchClinicData]);

  // Debug: Log all doctors data when it loads
  useEffect(() => {
    if (doctors.length > 0) {
      console.log('📋 All doctors loaded:', doctors.length);
    }
  }, [doctors]);


  const getDoctorAvatar = (doctorName: string) => {
    const defaultDoctorImage = "https://firebasestorage.googleapis.com/v0/b/kloqo-clinic-multi-33968-4c50b.firebasestorage.app/o/doctor_male.webp?alt=media&token=b19d8fb5-1812-4eb5-a879-d48739eaa87e";
    const doctor = doctors.find((d) => d.name === doctorName);
    const avatarUrl = doctor ? doctor.avatar : defaultDoctorImage;

    // Simplified debugging - only log if it's a Firebase URL
    if (avatarUrl?.includes('firebasestorage.googleapis.com')) {
      console.log(`🔍 Firebase URL for ${doctorName}:`, avatarUrl.substring(0, 100) + '...');
    }

    return avatarUrl;
  }

  const getDoctorsInDepartment = (departmentName: string) => {
    return doctors.filter(doctor => doctor.department === departmentName).map(d => d.name);
  }

  const DepartmentCard = ({ department, onDelete }: { department: Department, onDelete: (department: Department) => void }) => {
    const doctorsInDept = getDoctorsInDepartment(department.name);
    return (
      <Card className="overflow-hidden flex flex-col aspect-square">
        <div className="h-2/3 w-full flex items-center justify-center bg-muted/30">
          <DynamicIcon name={department.icon} className="w-16 h-16 text-muted-foreground opacity-50" />
        </div>
        <CardContent className="p-3 flex-grow flex flex-col justify-center">
          <div className="flex justify-between items-center">
            <div>
              <h3 className="text-base font-semibold truncate">{department.name}</h3>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-6 w-6 p-0">
                  <span className="sr-only">Open menu</span>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setViewingDoctorsDept(department)}>
                  <Users className="mr-2 h-4 w-4" />
                  See All Doctors
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onDelete(department)} className="text-red-600">
                  <Trash className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="flex items-center mt-1">
            <div className="flex -space-x-2">
              {doctorsInDept.slice(0, 3).map((doctorName, index) => {
                const avatarUrl = getDoctorAvatar(doctorName);
                return (
                  <div key={index} className="relative">
                    <Image
                      src={avatarUrl}
                      alt={doctorName}
                      width={24}
                      height={24}
                      className="w-6 h-6 rounded-full border-2 border-white object-cover"
                      onError={(e) => {
                        console.error(`❌ Failed to load doctor avatar for ${doctorName}`);
                        console.error(`🔗 Avatar URL causing error:`, avatarUrl);
                        console.error(`🔍 URL analysis:`, {
                          length: avatarUrl.length,
                          hasToken: avatarUrl.includes('token='),
                          domain: new URL(avatarUrl).hostname,
                          path: new URL(avatarUrl).pathname
                        });

                        // Prevent infinite retry loop
                        if (!e.currentTarget.hasAttribute('data-error-handled')) {
                          e.currentTarget.setAttribute('data-error-handled', 'true');
                          const defaultDoctorImage = "https://firebasestorage.googleapis.com/v0/b/kloqo-clinic-multi-33968-4c50b.firebasestorage.app/o/doctor_male.webp?alt=media&token=b19d8fb5-1812-4eb5-a879-d48739eaa87e";
                          e.currentTarget.src = defaultDoctorImage;
                        }
                      }}
                      onLoad={() => {
                        console.log(`✅ Doctor avatar loaded successfully for ${doctorName}`);
                      }}
                    />
                  </div>
                );
              })}
            </div>
            {doctorsInDept.length > 0 ? (
              <span className="text-xs text-muted-foreground ml-2 truncate">
                {doctorsInDept.length} {doctorsInDept.length > 1 ? 'doctors' : 'doctor'}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">No doctors</span>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  const handleSaveDepartments = async (selectedDepts: Department[]) => {
    if (!auth.currentUser) return;
    try {
      const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
      const clinicId = userDoc.data()?.clinicId;
      if (!clinicId) throw new Error("User has no clinic assigned.");

      const clinicRef = doc(db, "clinics", clinicId);
      const departmentIdsToAdd = selectedDepts.map(d => d.id);

      await updateDoc(clinicRef, {
        departments: arrayUnion(...departmentIdsToAdd)
      });

      fetchClinicData();

      toast({
        title: "Departments Added",
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

  const handleDeleteDepartment = async () => {
    if (!deletingDepartment || !auth.currentUser) return;
    try {
      const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
      const clinicId = userDoc.data()?.clinicId;
      if (!clinicId) throw new Error("User has no clinic assigned.");

      const clinicRef = doc(db, "clinics", clinicId);
      await updateDoc(clinicRef, {
        departments: arrayRemove(deletingDepartment.id)
      });

      setClinicDepartments(prev => prev.filter(d => d.id !== deletingDepartment.id));

      toast({
        title: "Department Deleted",
        description: `${deletingDepartment.name} has been removed.`,
      });
    } catch (error) {
      console.error("Error deleting department:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to delete department. Please try again.",
      });
    } finally {
      setDeletingDepartment(null);
    }
  }

  const availableMasterDepartments = masterDepartments.filter(
    (masterDept) => !clinicDepartments.some((clinicDept) => clinicDept.id === masterDept.id)
  );

  const isDepartmentLimitReached = clinicDetails ? clinicDepartments.length >= clinicDetails.numDoctors : false;


  return (
    <>
      <div className="flex flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b bg-background px-4 sm:static smh-auto sm:border-0 sm:bg-transparent sm:px-6">
          <h1 className="text-xl font-semibold md:text-2xl">Departments</h1>
          <div className="relative ml-auto flex-1 md:grow-0">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search departments..."
              className="w-full rounded-lg bg-background pl-8 md:w-[200px] lg:w-[320px]"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className={isDepartmentLimitReached ? "cursor-not-allowed" : ""}>
                  <Button onClick={() => setIsAddDepartmentOpen(true)} disabled={isDepartmentLimitReached}>
                    <PlusCircle className="mr-2 h-4 w-4" />
                    Add Department
                  </Button>
                </div>
              </TooltipTrigger>
              {isDepartmentLimitReached && (
                <TooltipContent>
                  <p>Department limit reached. Go to Profile &gt; Clinic Details to increase the limit.</p>
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
        </header>
        <main className="flex-1 p-4 sm:p-6 flex flex-col">
          <div className="grid flex-grow grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <Card key={i} className="h-full flex flex-col animate-pulse aspect-square">
                  <div className="h-2/3 w-full bg-muted"></div>
                  <CardContent className="p-3 flex-grow">
                    <div className="h-5 w-3/4 bg-muted rounded"></div>
                    <div className="h-4 w-full bg-muted rounded mt-2"></div>
                  </CardContent>
                </Card>
              ))
            ) : currentDepartments.length > 0 ? (
              currentDepartments.map((dept) => (
                <DepartmentCard key={dept.id} department={dept} onDelete={() => setDeletingDepartment(dept)} />
              ))
            ) : (
              <div className="col-span-full text-center py-12">
                <p className="text-muted-foreground">{clinicDepartments.length > 0 ? 'No departments match your search.' : 'No departments have been added to this clinic yet.'}</p>
              </div>
            )}
          </div>
        </main>
        <footer className="flex items-center justify-between p-4 border-t bg-background">
          <div className="text-sm text-muted-foreground">
            Showing {Math.min((currentPage - 1) * departmentsPerPage + 1, filteredDepartments.length)} to {Math.min(currentPage * departmentsPerPage, filteredDepartments.length)} of {filteredDepartments.length} departments
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))} disabled={currentPage === 1}>
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <Button variant="outline" size="sm" onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))} disabled={currentPage === totalPages}>
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </footer>

        <SelectDepartmentDialog
          isOpen={isAddDepartmentOpen}
          setIsOpen={setIsAddDepartmentOpen}
          departments={availableMasterDepartments}
          onDepartmentsSelect={handleSaveDepartments}
          limit={clinicDetails?.numDoctors}
          currentCount={clinicDepartments.length}
        />

        <AlertDialog open={!!deletingDepartment} onOpenChange={(open) => !open && setDeletingDepartment(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Are you sure?</AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone. This will permanently delete the {deletingDepartment?.name} department from your clinic.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleDeleteDepartment} className="bg-red-600 hover:bg-red-700">Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <DepartmentDoctorsDialog
          isOpen={!!viewingDoctorsDept}
          setIsOpen={(isOpen) => !isOpen && setViewingDoctorsDept(null)}
          department={viewingDoctorsDept}
          allDoctors={doctors}
        />
      </div>
    </>
  );
}
