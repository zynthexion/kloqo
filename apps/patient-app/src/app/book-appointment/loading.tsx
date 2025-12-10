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

            <main className="flex-1 p-4 md:p-6 space-y-6">
                {/* Doctor profile skeleton */}
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

                {/* Date selector skeleton */}
                <div className="space-y-3">
                    <Skeleton className="h-5 w-32" />
                    <div className="flex gap-3 overflow-x-auto pb-2">
                        {[1, 2, 3, 4, 5, 6, 7].map((i) => (
                            <div key={i} className="flex flex-col items-center gap-2 min-w-[60px]">
                                <Skeleton className="h-8 w-8 rounded-full" />
                                <Skeleton className="h-4 w-12" />
                                <Skeleton className="h-3 w-16" />
                            </div>
                        ))}
                    </div>
                </div>

                {/* Time slots skeleton */}
                <div className="space-y-4">
                    <Skeleton className="h-5 w-40" />
                    <div className="grid grid-cols-3 gap-3">
                        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
                            <Skeleton key={i} className="h-12 w-full rounded-lg" />
                        ))}
                    </div>
                </div>

                {/* Continue button skeleton */}
                <div className="pt-4">
                    <Skeleton className="h-12 w-full rounded-lg" />
                </div>
            </main>
        </div>
    );
}






