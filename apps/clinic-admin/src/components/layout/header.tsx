

import { Bell, Search, Settings, UserPlus, Calendar as CalendarIcon, Plus, Maximize, Minus, ZoomIn, ZoomOut, Activity, ChevronLeft, User, ChevronDown, ChevronUp } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";
import { user } from "@/lib/data";
import Link from "next/link";
import { format } from "date-fns";

export function DashboardHeader() {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 bg-background/80 backdrop-blur-sm px-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">{format(new Date(), "eeee, dd MMMM yyyy")}</p>
      </div>
       <Button size="sm" className="gap-1 rounded-full">
          <CalendarIcon className="h-4 w-4" />
          <span className="sm:whitespace-nowrap">
            Monthly
          </span>
        </Button>
    </header>
  );
}


export function DoctorsHeader() {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b bg-background px-4 sm:static sm:h-auto sm:border-0 sm:bg-transparent sm:px-6">
      
      <h1 className="text-xl font-semibold md:text-2xl">Doctors</h1>
    </header>
  );
}


export function AppointmentsHeader({ onAddAppointment }: { onAddAppointment: () => void }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b bg-background px-4 sm:static smh-auto sm:border-0 sm:bg-transparent sm:px-6">
      
      <h1 className="text-xl font-semibold md:text-2xl">Appointments</h1>
      <div className="ml-auto flex items-center gap-4">
         <div className="relative flex-1 md:grow-0">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search placeholder"
              className="w-full rounded-lg bg-background pl-8 md:w-[200px] lg:w-[320px]"
            />
          </div>
          <Button variant="outline" className="gap-2">
            <CalendarIcon className="h-4 w-4" />
            Today
          </Button>
          <Button onClick={onAddAppointment}>
            <Plus className="mr-2 h-4 w-4" />
            Add Appointment
          </Button>
      </div>
    </header>
  );
}

export function DepartmentsHeader() {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b bg-background px-4 sm:static smh-auto sm:border-0 sm:bg-transparent sm:px-6">
      
      <h1 className="text-xl font-semibold md:text-2xl">Departments</h1>
      <div className="relative ml-auto flex-1 md:grow-0">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Search departments..."
          className="w-full rounded-lg bg-background pl-8 md:w-[200px] lg:w-[320px]"
        />
      </div>
    </header>
  );
}

export function LiveStatusHeader() {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b bg-background px-4 sm:static smh-auto sm:border-0 sm:bg-transparent sm:px-6">
      
      <h1 className="text-xl font-semibold md:text-2xl flex items-center gap-2">
        <Activity /> Live Token Status
      </h1>
    </header>
  );
}

export function LiveStatusDetailHeader() {
    return (
      <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b bg-background px-4 sm:static sm:h-auto sm:border-0 sm:bg-transparent sm:px-6">
        
        <Link href="/live-status">
            <Button variant="outline" size="icon" className="h-7 w-7">
                <ChevronLeft className="h-4 w-4" />
                <span className="sr-only">Back</span>
            </Button>
        </Link>
        <h1 className="text-xl font-semibold md:text-2xl flex items-center gap-2">
            Token Overview
        </h1>
      </header>
    );
  }

export function MobileAppHeader() {
    return (
      <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b bg-background px-4 sm:static sm:h-auto sm:border-0 sm:bg-transparent sm:px-6">
        
        <h1 className="text-xl font-semibold md:text-2xl">Mobile App</h1>
      </header>
    );
  }

export function ProfileHeader() {
    return (
      <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b bg-background px-4 sm:static sm:h-auto sm:border-0 sm:bg-transparent sm:px-6">
        <h1 className="text-xl font-semibold md:text-2xl flex items-center gap-2">
            <User className="h-5 w-5" /> Profile
        </h1>
      </header>
    );
}
    

    

    
