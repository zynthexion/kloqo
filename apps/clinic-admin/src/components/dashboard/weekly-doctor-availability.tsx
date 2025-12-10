
"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { Doctor } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CalendarDays, ChevronDown } from "lucide-react";
import { addDays, format, getDay } from "date-fns";
import Image from "next/image";
import { ScrollArea } from "../ui/scroll-area";

const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayColors = [
    "bg-blue-50 dark:bg-blue-900/30",
    "bg-green-50 dark:bg-green-900/30",
    "bg-yellow-50 dark:bg-yellow-900/30",
    "bg-purple-50 dark:bg-purple-900/30",
    "bg-pink-50 dark:bg-pink-900/30",
    "bg-indigo-50 dark:bg-indigo-900/30",
    "bg-teal-50 dark:bg-teal-900/30",
];


export default function WeeklyDoctorAvailability() {
  const [isOpen, setIsOpen] = useState(false);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchDoctors = async () => {
      const doctorsCollection = collection(db, "doctors");
      const doctorsSnapshot = await getDocs(doctorsCollection);
      const doctorsList = doctorsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Doctor));
      setDoctors(doctorsList);
    };
    fetchDoctors();
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (drawerRef.current && !drawerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [drawerRef]);


  const weeklySchedule = useMemo(() => {
    const schedule = [];
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const date = addDays(today, i);
      const dayName = daysOfWeek[getDay(date)];
      const availableDoctors = doctors.filter(doctor => 
        doctor.availabilitySlots?.some(slot => slot.day === dayName)
      );
      schedule.push({
        date,
        dayName,
        doctors: availableDoctors,
      });
    }
    return schedule;
  }, [doctors]);

  return (
    <div className="fixed bottom-0 left-1/2 -translate-x-1/2 z-50 w-full max-w-6xl">
      <div ref={drawerRef} className="relative flex flex-col items-center">
        <div className={cn("transition-all duration-300", isOpen && "translate-y-full opacity-0")}>
            <Button 
                className="relative h-16 w-16 rounded-full shadow-lg animate-wave"
                size="icon" 
                onClick={() => setIsOpen(true)}
            >
                <CalendarDays className="h-8 w-8" />
            </Button>
        </div>

        <div className={cn(
            "absolute bottom-0 w-full transition-all duration-500 ease-in-out",
            isOpen ? "translate-y-0 opacity-100" : "translate-y-full opacity-0 pointer-events-none"
        )}>
          <Card className="rounded-t-2xl rounded-b-none border-b-0 shadow-2xl bg-gradient-to-t from-background to-muted/50 border-t-2">
            <CardContent className="p-4">
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => setIsOpen(false)}
                className="w-full text-muted-foreground"
              >
                <ChevronDown className="h-5 w-5" />
              </Button>
              <div className="grid grid-cols-7 gap-4 mt-2">
                {weeklySchedule.map((day, index) => (
                  <div key={index} className={cn("p-4 rounded-xl", dayColors[index % dayColors.length])}>
                    <div className="text-center mb-3">
                        <p className="font-bold text-lg">{format(day.date, "EEE")}</p>
                        <p className="text-sm text-muted-foreground">{format(day.date, "d MMM")}</p>
                    </div>
                    <ScrollArea className="h-40">
                        <div className="space-y-2 pr-3">
                            {day.doctors.length > 0 ? day.doctors.map(doctor => (
                                <div key={doctor.id} className="flex items-center gap-2 p-2 bg-background/70 rounded-lg transition-colors hover:bg-background">
                                    <Image 
                                        src={doctor.avatar} 
                                        alt={doctor.name}
                                        width={28}
                                        height={28}
                                        className="rounded-full"
                                        data-ai-hint="doctor portrait"
                                    />
                                    <p className="text-xs font-medium truncate">{doctor.name}</p>
                                </div>
                            )) : (
                                <div className="flex items-center justify-center h-full pt-8">
                                    <p className="text-xs text-muted-foreground">No doctors</p>
                                </div>
                            )}
                        </div>
                    </ScrollArea>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
