
'use client';

import type { Patient } from '@/lib/types';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

type PatientSearchResultsProps = {
    patients: Patient[];
    onSelectPatient: (patient: Patient) => void;
    selectedPatientId: string | null;
};

export default function PatientSearchResults({ patients, onSelectPatient, selectedPatientId }: PatientSearchResultsProps) {

    if (patients.length === 0) {
        return null;
    }

    return (
        <Card>
            <CardContent className="p-2 space-y-1">
                <p className="text-xs text-muted-foreground px-2 py-1">Select an existing patient or family member:</p>
                {patients.map(p => (
                    <div 
                        key={p.id} 
                        className={cn(
                            "w-full text-left p-2 rounded-md hover:bg-muted/80 flex justify-between items-center",
                            selectedPatientId === p.id && "bg-muted"
                        )}
                    >
                        <div>
                            <p className="font-semibold">{p.name || 'Unnamed Patient'}</p>
                            <p className="text-sm text-muted-foreground">
                                {p.age ? `${p.age} yrs, ` : ''}
                                {p.place}
                            </p>
                        </div>
                        <div className='flex items-center gap-2'>
                          {p.isKloqoMember && <Badge variant="secondary">Existing Patient</Badge>}
                          <Button size="sm" variant="outline" onClick={() => onSelectPatient(p)}>
                            Select
                          </Button>
                        </div>
                    </div>
                ))}
            </CardContent>
        </Card>
    );
}
