'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';

export default function Loading() {
    return (
        <div className="flex min-h-screen w-full flex-col bg-background font-body pb-24">
            <header className="flex items-center p-4 border-b">
                <Skeleton className="h-10 w-10 rounded-full" />
                <Skeleton className="h-6 flex-1 mx-4" />
                <div className="w-10"></div>
            </header>

            <main className="flex-1 p-6 space-y-6">
                {/* Doctor info skeleton */}
                <Card>
                    <CardContent className="flex items-center gap-4 pt-6">
                        <Skeleton className="h-20 w-20 rounded-full" />
                        <div className="space-y-2 flex-1">
                            <Skeleton className="h-6 w-40" />
                            <Skeleton className="h-5 w-32" />
                            <Skeleton className="h-4 w-24" />
                        </div>
                    </CardContent>
                </Card>

                {/* Appointment details skeleton */}
                <Card>
                    <CardContent className="pt-6 space-y-4">
                        <Skeleton className="h-5 w-32" />
                        <div className="space-y-3">
                            <div className="flex justify-between">
                                <Skeleton className="h-4 w-24" />
                                <Skeleton className="h-4 w-32" />
                            </div>
                            <div className="flex justify-between">
                                <Skeleton className="h-4 w-20" />
                                <Skeleton className="h-4 w-28" />
                            </div>
                            <div className="flex justify-between">
                                <Skeleton className="h-4 w-28" />
                                <Skeleton className="h-4 w-24" />
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Action buttons skeleton */}
                <div className="space-y-3">
                    <Skeleton className="h-12 w-full rounded-lg" />
                    <Skeleton className="h-12 w-full rounded-lg" />
                </div>
            </main>
        </div>
    );
}






