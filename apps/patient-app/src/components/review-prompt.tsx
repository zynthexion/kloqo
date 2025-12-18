'use client';

import { useState } from 'react';
import { Star, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useFirestore } from '@/firebase';
import { collection, addDoc, doc, getDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import type { Appointment } from '@/lib/types';
import { useLanguage } from '@/contexts/language-context';

interface ReviewPromptProps {
    appointment: Appointment;
    onClose: (wasSkipped?: boolean) => void;
}

export function ReviewPrompt({ appointment, onClose }: ReviewPromptProps) {
    const [rating, setRating] = useState(0);
    const [hoveredRating, setHoveredRating] = useState(0);
    const [feedback, setFeedback] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const firestore = useFirestore();
    const { toast } = useToast();
    const { t } = useLanguage();

    const handleSubmit = async (): Promise<void> => {
        if (rating === 0) {
            toast({
                variant: 'destructive',
                title: t.reviews.ratingRequired,
                description: t.reviews.ratingRequiredDesc,
            });
            return;
        }

        if (!firestore || !appointment.doctorId) {
            toast({
                variant: 'destructive',
                title: t.reviews.error,
                description: t.reviews.submitError,
            });
            return;
        }

        setIsSubmitting(true);

        try {
            // Create review document
            const reviewRef = await addDoc(collection(firestore, 'reviews'), {
                appointmentId: appointment.id,
                doctorId: appointment.doctorId,
                doctorName: appointment.doctor,
                patientId: appointment.patientId,
                patientName: appointment.patientName,
                rating,
                feedback: feedback.trim() || '',
                createdAt: serverTimestamp(),
                clinicId: appointment.clinicId,
            });

            // Update appointment with review status
            const appointmentRef = doc(firestore, 'appointments', appointment.id);
            await updateDoc(appointmentRef, {
                reviewed: true,
                reviewId: reviewRef.id,
            });

            // Update doctor's reviewList
            const doctorRef = doc(firestore, 'doctors', appointment.doctorId);
            const doctorDoc = await getDoc(doctorRef);

            if (doctorDoc.exists()) {
                const doctorData = doctorDoc.data();
                const existingReviews = doctorData.reviewList || [];
                // Use regular Date instead of serverTimestamp() for array items
                const newReview = {
                    id: reviewRef.id,
                    appointmentId: appointment.id,
                    doctorId: appointment.doctorId!,
                    doctorName: appointment.doctor,
                    patientId: appointment.patientId,
                    patientName: appointment.patientName,
                    rating,
                    feedback: feedback.trim() || '',
                    createdAt: new Date(), // Use Date object instead of serverTimestamp() for arrays
                    clinicId: appointment.clinicId,
                };

                // Update rating average
                const totalRating = existingReviews.reduce((sum: number, r: any) => sum + r.rating, 0);
                const newRating = (totalRating + rating) / (existingReviews.length + 1);

                await updateDoc(doctorRef, {
                    reviewList: [...existingReviews, newReview],
                    rating: newRating,
                    reviews: (doctorData.reviews || 0) + 1,
                });
            }
            toast({
                title: t.reviews.thankYou,
                description: t.reviews.successDesc,
            });

            onClose(false);
        } catch (error) {
            console.error('Error submitting review:', error);
            toast({
                variant: 'destructive',
                title: t.reviews.error,
                description: t.reviews.failedError,
            });
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <Card className="w-full max-w-md">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle>{t.reviews.title}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div>
                        <p className="text-sm text-muted-foreground mb-2">
                            {t.reviews.howWasDoctor.replace('{doctor}', appointment.doctor)}
                        </p>
                        <div className="flex gap-2">
                            {[1, 2, 3, 4, 5].map((star) => (
                                <button
                                    key={star}
                                    type="button"
                                    onClick={() => setRating(star)}
                                    onMouseEnter={() => setHoveredRating(star)}
                                    onMouseLeave={() => setHoveredRating(0)}
                                    className="transition-colors"
                                >
                                    <Star
                                        className="h-8 w-8"
                                        fill={
                                            star <= (hoveredRating || rating)
                                                ? '#FFD700'
                                                : 'none'
                                        }
                                        stroke={
                                            star <= (hoveredRating || rating)
                                                ? '#FFD700'
                                                : '#D1D5DB'
                                        }
                                    />
                                </button>
                            ))}
                        </div>
                    </div>

                    <div>
                        <label className="text-sm font-medium mb-2 block">
                            {t.reviews.feedbackLabel}
                        </label>
                        <Textarea
                            placeholder={t.reviews.feedbackPlaceholder}
                            value={feedback}
                            onChange={(e) => setFeedback(e.target.value)}
                            rows={4}
                            maxLength={500}
                        />
                        <p className="text-xs text-muted-foreground mt-1">
                            {feedback.length}/500 {t.reviews.characters}
                        </p>
                    </div>

                    <div className="flex pt-2">
                        <Button
                            className="w-full"
                            onClick={() => {
                                handleSubmit().then(() => {
                                    onClose(false);
                                }).catch(() => {
                                    // Error already handled in handleSubmit
                                });
                            }}
                            disabled={isSubmitting || rating === 0}
                        >
                            {isSubmitting ? (
                                t.reviews.submitting
                            ) : (
                                <>
                                    <Send className="mr-2 h-4 w-4" />
                                    {t.reviews.submit}
                                </>
                            )}
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}

