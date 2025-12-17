'use client';

import { useEffect, useState } from 'react';
import { useFirebase } from '@/firebase/provider';
import { checkAndSendDailyReminders } from '@kloqo/shared-core/services/notification-service';
import { format } from 'date-fns';
import { useAuth } from '@/contexts/AuthContext';

export function DailyReminderHandler() {
    const { firestore } = useFirebase();
    const { user } = useAuth(); // Removed userRole as it might not be directly exposed or needed if we check user.role or implicit clinicId
    const [hasChecked, setHasChecked] = useState(false);

    useEffect(() => {
        // Requirements:
        // 1. User must be logged in
        // 2. Firestore must be initialized
        // 3. Must not have already run today
        if (!user || !firestore || hasChecked) return;

        // Optional: Restrict to 'admin' or specfic roles if needed
        // if (userRole !== 'admin') return; 

        const today = format(new Date(), 'yyyy-MM-dd');
        const lastRunDate = localStorage.getItem('last_daily_reminder_run');

        if (lastRunDate === today) {
            // Already run today
            console.log('Daily reminders already run today.');
            setHasChecked(true);
            return;
        }

        const runCheck = async () => {
            // Get clinicID from user profile or context
            // Assuming user.clinicId is available on the user object or typical pattern
            // If not, we might need to fetch the user doc. 
            // For now, let's assume `user.clinicId` if available, or try to get it.

            const clinicId = user.clinicId;
            if (!clinicId) {
                console.warn('DailyReminderHandler: No clinicId found for user.');
                return;
            }

            console.log('Running Daily Reminder Check...');
            await checkAndSendDailyReminders({ firestore, clinicId });

            // Mark as done
            localStorage.setItem('last_daily_reminder_run', today);
            setHasChecked(true);
        };

        runCheck();

    }, [user, firestore, hasChecked]);

    return null; // Logic only, no UI
}
