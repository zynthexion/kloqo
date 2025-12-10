
'use client';

import { Patient } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { UserPlus, UserCheck, Crown, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';

interface PatientSearchResultsProps {
  patients: Patient[];
  onSelectPatient: (patient: Patient) => void;
  selectedPatientId: string | null;
}

export default function PatientSearchResults({ patients, onSelectPatient, selectedPatientId }: PatientSearchResultsProps) {
  
  return (
    <Card>
      <CardContent className="p-2">
        <ScrollArea className="h-48">
          <div className="space-y-2">
            {patients.map(patient => (
              <div
                key={patient.id}
                onClick={() => onSelectPatient(patient)}
                className={cn(
                  "flex items-center justify-between p-3 rounded-md cursor-pointer transition-colors",
                  selectedPatientId === patient.id ? "bg-primary/10" : "hover:bg-muted/50"
                )}
              >
                <div className="flex flex-col">
                  <span className="font-semibold">{patient.name || "Unnamed Patient"}</span>
                  <span className="text-xs text-muted-foreground">{patient.phone}</span>
                </div>
                <div className="flex items-center gap-2">
                    <Badge variant={patient.isKloqoMember ? "secondary" : "outline"} className={cn(
                        patient.isKloqoMember ? "text-blue-600 border-blue-500" : "text-amber-600 border-amber-500"
                    )}>
                        {patient.isKloqoMember ? (
                            <UserCheck className="mr-1.5 h-3 w-3" />
                        ) : (
                            <Crown className="mr-1.5 h-3 w-3" />
                        )}
                        {patient.isKloqoMember ? "Existing Patient" : "Kloqo Member"}
                    </Badge>
                    {selectedPatientId === patient.id && <Check className="h-5 w-5 text-primary" />}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

    