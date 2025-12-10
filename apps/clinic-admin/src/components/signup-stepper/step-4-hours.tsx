
'use client';

import { useFormContext, useFieldArray } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { SignUpFormData } from '@/app/(public)/signup/page';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { PlusCircle, Trash2 } from 'lucide-react';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '../ui/form';

export function Step4Hours() {
  const { control } = useFormContext<SignUpFormData>();
  const { fields, update } = useFieldArray({
    control,
    name: 'hours',
  });

  const handleTimeChange = (dayIndex: number, slotIndex: number, field: 'open' | 'close', value: string) => {
    const day = fields[dayIndex];
    const newTimeSlots = [...day.timeSlots];
    newTimeSlots[slotIndex][field] = value;
    update(dayIndex, { ...day, timeSlots: newTimeSlots });
  };
  
  const addTimeSlot = (dayIndex: number) => {
    const day = fields[dayIndex];
    const newTimeSlots = [...day.timeSlots, { open: '14:00', close: '18:00' }];
    update(dayIndex, { ...day, timeSlots: newTimeSlots });
  };
  
  const removeTimeSlot = (dayIndex: number, slotIndex: number) => {
    const day = fields[dayIndex];
    const newTimeSlots = day.timeSlots.filter((_, index) => index !== slotIndex);
    update(dayIndex, { ...day, timeSlots: newTimeSlots });
  };

  const handleClosedToggle = (dayIndex: number, isClosed: boolean) => {
    const day = fields[dayIndex];
    update(dayIndex, { ...day, isClosed });
  };

  return (
    <div>
      <p className="text-sm text-muted-foreground">Step 4/7</p>
      <h2 className="text-2xl font-bold mb-1">Operating Hours</h2>
      <p className="text-muted-foreground mb-6">Set your clinic's working hours and weekly offs.</p>
      
      <div className="space-y-4">
        <FormField
          control={control}
          name="avgPatientsPerDay"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Average Patients per Day</FormLabel>
              <FormControl>
                <Input 
                    type="number" 
                    min="1" 
                    placeholder="e.g. 40" 
                    {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {fields.map((hour, dayIndex) => (
          <div key={hour.id} className={cn("p-4 border rounded-lg", hour.isClosed && "bg-muted/50")}>
            <div className="flex items-center justify-between mb-4">
              <p className={cn("w-24 font-semibold", hour.isClosed && "text-muted-foreground")}>{hour.day}</p>
              <div className="flex items-center space-x-2">
                <Label htmlFor={`closed-switch-${dayIndex}`}>{hour.isClosed ? 'Closed' : 'Open'}</Label>
                <Switch
                  id={`closed-switch-${dayIndex}`}
                  checked={!hour.isClosed}
                  onCheckedChange={(checked) => handleClosedToggle(dayIndex, !checked)}
                />
              </div>
            </div>

            {!hour.isClosed && (
              <div className="space-y-3">
                {hour.timeSlots.map((slot, slotIndex) => (
                   <div key={slotIndex} className="flex items-end gap-2">
                      <div className="space-y-1 flex-grow">
                        <Label htmlFor={`open-time-${dayIndex}-${slotIndex}`} className="text-xs">Open</Label>
                        <Input
                          id={`open-time-${dayIndex}-${slotIndex}`}
                          type="time"
                          defaultValue={slot.open}
                          onChange={e => handleTimeChange(dayIndex, slotIndex, 'open', e.target.value)}
                        />
                      </div>
                      <div className="space-y-1 flex-grow">
                        <Label htmlFor={`close-time-${dayIndex}-${slotIndex}`} className="text-xs">Close</Label>
                        <Input
                          id={`close-time-${dayIndex}-${slotIndex}`}
                          type="time"
                          defaultValue={slot.close}
                          onChange={e => handleTimeChange(dayIndex, slotIndex, 'close', e.target.value)}
                        />
                      </div>
                      <Button 
                        type="button" 
                        variant="ghost" 
                        size="icon" 
                        onClick={() => removeTimeSlot(dayIndex, slotIndex)}
                        disabled={hour.timeSlots.length <= 1}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                   </div>
                ))}
                 <Button type="button" variant="link" size="sm" onClick={() => addTimeSlot(dayIndex)} className="text-primary">
                  <PlusCircle className="mr-2 h-4 w-4" /> Add Slot
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
