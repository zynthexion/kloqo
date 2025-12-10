'use client';

import { useState } from 'react';
import { Star, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { format } from 'date-fns';
import type { Review } from '@/lib/types';

interface ReviewsSectionProps {
    reviews: Review[];
}

export function ReviewsSection({ reviews }: ReviewsSectionProps) {
    const [currentPage, setCurrentPage] = useState(1);
    const reviewsPerPage = 5;
    const totalPages = Math.ceil(reviews.length / reviewsPerPage);

    const paginatedReviews = reviews.slice(
        (currentPage - 1) * reviewsPerPage,
        currentPage * reviewsPerPage
    );

    if (reviews.length === 0) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Reviews</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-center text-muted-foreground py-8">
                        No reviews yet. Patients can leave reviews after their appointments are completed.
                    </p>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>Reviews ({reviews.length})</CardTitle>
            </CardHeader>
            <CardContent>
                <div className="space-y-4">
                    {paginatedReviews.map((review) => (
                        <div key={review.id} className="border-b pb-4 last:border-b-0">
                            <div className="flex items-start gap-4">
                                <Avatar className="h-10 w-10">
                                    <AvatarFallback>
                                        {review.patientName
                                            .split(' ')
                                            .map(n => n[0])
                                            .join('')
                                            .toUpperCase()}
                                    </AvatarFallback>
                                </Avatar>
                                <div className="flex-grow">
                                    <div className="flex items-center gap-2 mb-1">
                                        <p className="font-semibold">{review.patientName}</p>
                                        <div className="flex gap-0.5">
                                            {[1, 2, 3, 4, 5].map((star) => (
                                                <Star
                                                    key={star}
                                                    className="h-4 w-4"
                                                    fill={star <= review.rating ? '#FFD700' : 'none'}
                                                    stroke={star <= review.rating ? '#FFD700' : '#D1D5DB'}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                    <p className="text-sm text-muted-foreground mb-2">
                                        {review.feedback || 'No feedback provided'}
                                    </p>
                                    {review.createdAt && (
                                        <p className="text-xs text-muted-foreground">
                                            {format(
                                                review.createdAt?.toDate ? review.createdAt.toDate() : review.createdAt,
                                                'MMM d, yyyy'
                                            )}
                                        </p>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>

                {totalPages > 1 && (
                    <div className="flex items-center justify-between mt-4 pt-4 border-t">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                            disabled={currentPage === 1}
                        >
                            <ChevronLeft className="h-4 w-4 mr-1" />
                            Previous
                        </Button>
                        <span className="text-sm text-muted-foreground">
                            Page {currentPage} of {totalPages}
                        </span>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                            disabled={currentPage === totalPages}
                        >
                            Next
                            <ChevronRight className="h-4 w-4 ml-1" />
                        </Button>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}


