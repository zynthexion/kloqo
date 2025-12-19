'use client';

import { format, parse, subMinutes } from 'date-fns';
import type { Appointment } from '@/lib/types';
import { cn, getDisplayTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { User, Phone, Coffee, Check, X, AlertTriangle } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

type NowServingItemProps = {
  appointment: Appointment;
  onUpdateStatus: (id: string, status: 'completed' | 'Cancelled' | 'No-show') => void;
};

export default function NowServingItem({ appointment: appt, onUpdateStatus }: NowServingItemProps) {
  const getIcon = (type: Appointment['bookedVia']) => {
    switch (type) {
      case 'Online': return <User className="text-blue-500" />;
      case 'Walk-in': return <User className="text-green-500" />;
      case 'Advanced Booking': return <Phone className="text-purple-500" />;
      // @ts-ignore
      case 'break': return <Coffee className="text-orange-500" />;
      default: return <User className="text-gray-500" />;
    }
  };

  const isActionable = appt.status === 'Pending' || appt.status === 'Confirmed';

  return (
    <div className={cn(
      "p-4 flex flex-col gap-4 border-b",
      appt.status === 'No-show' && 'bg-amber-50 border-amber-200',
      appt.status === 'Completed' && 'bg-green-50/50',
      appt.status === 'Cancelled' && 'bg-gray-100 opacity-60',
    )}>
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-4">
          <div className="mt-1">{getIcon(appt.bookedVia)}</div>
          <div>
            <p className={cn("font-semibold", !isActionable && 'line-through text-muted-foreground')}>
              #{appt.tokenNumber} - {appt.patientName}
            </p>
            <p className="text-sm text-muted-foreground">
              {appt.age} yrs, {appt.place}
            </p>
            <Badge variant="outline" className="text-xs">
              {getDisplayTime(appt)}
            </Badge>
            {appt.status !== 'Pending' && <Badge variant={appt.status === 'No-show' ? 'destructive' : 'secondary'}>{appt.status}</Badge>}
          </div>
        </div>
      </div>
    </div>

      {
    isActionable && (appt.bookedVia as string) !== 'break' && (
      <div className="flex items-center justify-end gap-2">
        {appt.status === 'Pending' && (
          <>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="text-destructive border-destructive/50 hover:bg-destructive/10 hover:text-destructive">
                  <X className="mr-2 h-4 w-4" /> Cancel
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Cancel Appointment?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to cancel this appointment for {appt.patientName}? This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Go Back</AlertDialogCancel>
                  <AlertDialogAction onClick={() => onUpdateStatus(appt.id, 'Cancelled')} className="bg-destructive hover:bg-destructive/90">
                    Confirm Cancel
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <Button variant="outline" size="sm" onClick={() => onUpdateStatus(appt.id, 'No-show')}>
              <AlertTriangle className="mr-2 h-4 w-4" /> No-show
            </Button>
          </>
        )}

        <Button size="sm" className="bg-green-600 hover:bg-green-700" onClick={() => onUpdateStatus(appt.id, 'completed')}>
          <Check className="mr-2 h-4 w-4" /> Complete
        </Button>
      </div>
    )
  }
    </div >
  );
}
