
"use client";

import { useState, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, CheckCircle } from "lucide-react";
import type { Department } from "@/lib/types";
import * as Lucide from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const Pregnant = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 16.5a2.5 2.5 0 1 1-5 0c0-4.5 5-10.5 5-10.5s5 6 5 10.5a2.5 2.5 0 1 1-5 0Z"/>
    <path d="M10 16.5a2.5 2.5 0 1 0-5 0c0-4.5-5-10.5-5-10.5s5 6 5 10.5a2.5 2.5 0 1 0-5 0Z"/>
    <path d="M8 8a4 4 0 1 0 8 0c0-2.5-4-6-4-6s-4 3.5-4 6Z"/>
  </svg>
);

const Tooth = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20.3 13.4c.5-1 .5-2.2.1-3.2-.4-1-1.2-1.8-2.2-2.2-.9-.4-2-.5-3-.1-1.1.4-2.1 1.2-2.7 2.2-.6-1-1.6-1.8-2.7-2.2-1.1-.4-2.1-.2-3 .1-1 .4-1.8 1.2-2.2 2.2-.4 1-.4 2.2.1 3.2.5 1 1.2 1.8 2.2 2.2.9.4 2 .5 3 .1 1.1-.4 2.1-1.2 2.7-2.2.6 1 1.6 1.8 2.7 2.2 1 .4 2.1.2 3-.1 1-.4 1.8-1.2 2.2-2.2Z"/>
        <path d="m18 13-1.5-3.5"/>
        <path d="m6 13 1.5-3.5"/>
        <path d="M12 18.5V22"/>
        <path d="M9.5 15.5s-1-2-2-2"/>
        <path d="M14.5 15.5s1-2 2-2"/>
    </svg>
);

const iconMap: Record<string, React.FC<any>> = {
  ...Lucide,
  Pregnant,
  Tooth,
};

const DynamicIcon = ({ name, className }: { name: string; className: string }) => {
  const IconComponent = iconMap[name] || Lucide.Stethoscope;
  return <IconComponent className={className} />;
};

type SelectDepartmentDialogProps = {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  departments: Omit<Department, "clinicId">[];
  onDepartmentsSelect: (departments: Omit<Department, "clinicId">[]) => void;
  limit?: number;
  currentCount?: number;
};

export function SelectDepartmentDialog({ isOpen, setIsOpen, departments, onDepartmentsSelect, limit = Infinity, currentCount = 0 }: SelectDepartmentDialogProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [selected, setSelected] = useState<Omit<Department, "clinicId">[]>([]);
  const { toast } = useToast();

  const filteredDepartments = useMemo(() => {
    if (!departments) return [];
    return departments.filter((dept) =>
      dept.name.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [departments, searchTerm]);

  const toggleSelection = (department: Omit<Department, "clinicId">) => {
    const isAlreadySelected = selected.some(d => d.id === department.id);

    if (isAlreadySelected) {
      setSelected(prev => prev.filter(d => d.id !== department.id));
    } else {
      if (currentCount + selected.length >= limit) {
        toast({
          variant: "destructive",
          title: "Department Limit Reached",
          description: `You can only add up to ${limit} departments with your current plan.`,
        });
        return;
      }
      setSelected(prev => [...prev, department]);
    }
  }

  const handleAdd = () => {
    if (selected.length > 0) {
      onDepartmentsSelect(selected);
      setIsOpen(false);
      setSelected([]);
      setSearchTerm("");
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Departments to Your Clinic</DialogTitle>
          <DialogDescription>
            Select one or more departments from the list to add to your clinic setup. You can add {limit - (currentCount + selected.length)} more.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search departments..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-8"
          />
        </div>
        <ScrollArea className="h-72">
          <div className="space-y-2 pr-4">
            {filteredDepartments.map((dept) => {
              const isSelected = selected.some(d => d.id === dept.id);
              return (
                <div
                    key={dept.id}
                    className={`relative flex items-center gap-4 p-2 rounded-lg cursor-pointer transition-colors ${
                    isSelected
                        ? "bg-primary/20 ring-2 ring-primary"
                        : "hover:bg-muted/50"
                    }`}
                    onClick={() => toggleSelection(dept)}
                >
                    {isSelected && (
                        <div className="absolute top-2 right-2 bg-primary text-primary-foreground rounded-full">
                            <CheckCircle className="w-5 h-5" />
                        </div>
                    )}
                    <DynamicIcon name={dept.icon} className="w-10 h-10 text-muted-foreground" />
                    <div className="flex-grow">
                    <p className="font-semibold text-sm">{dept.name}</p>
                    <p className="text-xs text-muted-foreground">{dept.description}</p>
                    </div>
                </div>
              )
            })}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleAdd} disabled={selected.length === 0}>
            Add to Your Clinic
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
