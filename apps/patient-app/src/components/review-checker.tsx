'use client';

import { useState, useEffect } from 'react';
import { useFirestore } from '@/firebase';
import { useUser } from '@/firebase/auth/use-user';
import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
import { ReviewPrompt } from './review-prompt';
import { parseAppointmentDateTime, parseTime } from '@/lib/utils';
import { addHours, differenceInHours } from 'date-fns';
import type { Appointment } from '@/lib/types';

// Constants
const REVIEW_DELAY_HOURS = 1; // Wait 1 hour after completion before showing review
const REVIEW_COOLDOWN_HOURS = 24; // Don't show again for 24 hours if skipped

export function ReviewChecker() {
    const [pendingReview, setPendingReview] = useState<Appointment | null>(null);
    const firestore = useFirestore();
    const { user } = useUser();

    useEffect(() => {
        if (!firestore || !user) return;

        const checkForPendingReview = async () => {
            try {
                // Get user's patient data
                const usersRef = collection(firestore, 'users');
                const userQuery = query(usersRef, where('phone', '==', user.phoneNumber));
                const userSnapshot = await getDocs(userQuery);
                
                if (userSnapshot.empty) return;

                const userData = userSnapshot.docs[0].data();
                const patientId = userData.patientId;
                
                if (!patientId) return;

                // Get patient's appointments that are completed but not reviewed
                const appointmentsRef = collection(firestore, 'appointments');
                const appointmentsQuery = query(
                    appointmentsRef,
                    where('patientId', '==', patientId),
                    where('status', '==', 'Completed')
                );
                
                const appointmentsSnapshot = await getDocs(appointmentsQuery);
                const completedAppointments = appointmentsSnapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                })) as Appointment[];

                // Find the most recent completed appointment that hasn't been reviewed
                const unreviewedAppointments = completedAppointments
                    .filter(apt => !apt.reviewed)
                    .sort((a, b) => {
                        const aDate = a.createdAt?.toMillis() || 0;
                        const bDate = b.createdAt?.toMillis() || 0;
                        return bDate - aDate;
                    });

                const now = new Date();

                // Check each unreviewed appointment
                for (const appointment of unreviewedAppointments) {
                    // Check if appointment has been dismissed/skipped recently
                    const skipKey = `review_skipped_${appointment.id}`;
                    const skipData = localStorage.getItem(skipKey);
                    
                    if (skipData) {
                        const skipTimestamp = parseInt(skipData, 10);
                        const hoursSinceSkip = differenceInHours(now, new Date(skipTimestamp));
                        
                        // If skipped less than 24 hours ago, skip this appointment
                        if (hoursSinceSkip < REVIEW_COOLDOWN_HOURS) {
                            continue; // Skip this appointment, try next one
                        }
                    }

                    // Calculate when the appointment was completed
                    // Use appointment date/time + average consulting time as completion time
                    try {
                        const appointmentDateTime = parseAppointmentDateTime(appointment.date, appointment.time);
                        
                        // Get doctor's average consulting time (default to 15 minutes)
                        let avgConsultingTime = 15;
                        if (appointment.doctorId) {
                            try {
                                const doctorRef = doc(firestore, 'doctors', appointment.doctorId);
                                const doctorDoc = await getDoc(doctorRef);
                                if (doctorDoc.exists()) {
                                    avgConsultingTime = doctorDoc.data()?.averageConsultingTime || 15;
                                }
                            } catch (err) {
                                console.error('Error fetching doctor data for review:', err);
                            }
                        }

                        // Estimate completion time: appointment time + average consulting time
                        const estimatedCompletionTime = addHours(appointmentDateTime, avgConsultingTime / 60);
                        
                        // Calculate when review should be shown (completion + delay)
                        const reviewShowTime = addHours(estimatedCompletionTime, REVIEW_DELAY_HOURS);
                        
                        // Only show if enough time has passed
                        if (now >= reviewShowTime) {
                            setPendingReview(appointment);
                            return; // Found one, stop looking
                        }
                    } catch (error) {
                        // If date parsing fails, skip this appointment
                        console.error('Error parsing appointment date for review:', error);
                        continue;
                    }
                }
            } catch (error) {
                console.error('Error checking for pending reviews:', error);
            }
        };

        checkForPendingReview();
        
        // Recheck every hour in case a review becomes eligible
        const interval = setInterval(checkForPendingReview, 60 * 60 * 1000);
        
        return () => clearInterval(interval);
    }, [firestore, user]);

    if (!pendingReview) return null;

    return (
        <ReviewPrompt
            appointment={pendingReview}
            onClose={(wasSkipped?: boolean) => {
                if (wasSkipped) {
                    // Store skip timestamp for cooldown period
                    const skipKey = `review_skipped_${pendingReview.id}`;
                    localStorage.setItem(skipKey, Date.now().toString());
                }
                setPendingReview(null);
            }}
        />
    );
}


