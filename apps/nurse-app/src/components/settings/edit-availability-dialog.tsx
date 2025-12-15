
'use client';

import { useState, useEffect } from 'react';
import { format, parse } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';

type TimeSlot = { from: string; to: string };

type EditAvailabilityDialogProps = {
    isOpen: boolean;
    onOpenChange: (isOpen: boolean) => void;
    onSave: (days: string[], slot: TimeSlot) => void;
    days: string[];
};

export default function EditAvailabilityDialog({
    isOpen,
    onOpenChange,
    onSave,
    days,
}: EditAvailabilityDialogProps) {
    const { toast } = useToast();
    const [fromTime, setFromTime] = useState('');
    const [toTime, setToTime] = useState('');

    useEffect(() => {
        if (isOpen) {
            setFromTime('');
            setToTime('');
        }
    }, [isOpen]);

    const handleSave = () => {
        if (days.length === 0) {
            toast({ variant: 'destructive', title: 'No Days Selected', description: 'Please select at least one day.' });
            return;
        }
        if (!fromTime || !toTime) {
            toast({ variant: 'destructive', title: 'Error', description: 'Please fill in both "From" and "To" time fields.' });
            return;
        }

        if (fromTime >= toTime) {
            toast({ variant: 'destructive', title: 'Invalid Time Range', description: '"From" time must be before "To" time.' });
            return;
        }

        let formattedFromTime = fromTime;
        let formattedToTime = toTime;

        try {
            // Input type="time" returns HH:mm (24h)
            // We parse it as a reference date to format it as 12h
            const fromDate = parse(fromTime, 'HH:mm', new Date());
            const toDate = parse(toTime, 'HH:mm', new Date());

            formattedFromTime = format(fromDate, 'hh:mm a');
            formattedToTime = format(toDate, 'hh:mm a');
        } catch (e) {
            console.error("Error formatting time for display:", e);
            // Fallback to raw value if parsing fails
        }

        onSave(days, { from: formattedFromTime, to: formattedToTime });
    };

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Add Time Slot</DialogTitle>
                    <DialogDescription>
                        Add a new time slot for {days.map(d => d.slice(0, 3)).join(', ')}. Use 24-hour format (e.g., 14:00 for 2 PM).
                    </DialogDescription>
                </DialogHeader>
                <div className="py-4 grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label htmlFor="fromTime">From</Label>
                        <Input
                            id="fromTime"
                            type="time"
                            value={fromTime}
                            onChange={(e) => setFromTime(e.target.value)}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="toTime">To</Label>
                        <Input
                            id="toTime"
                            type="time"
                            value={toTime}
                            onChange={(e) => setToTime(e.target.value)}
                        />
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button onClick={handleSave}>Add to {days.length} Day(s)</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}


