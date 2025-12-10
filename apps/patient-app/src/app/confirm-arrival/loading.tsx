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
                {/* Clinic info skeleton */}
                <Card>
                    <CardContent className="pt-6 space-y-4">
                        <div className="flex items-center gap-4">
                            <Skeleton className="h-16 w-16 rounded-full" />
                            <div className="space-y-2 flex-1">
                                <Skeleton className="h-6 w-3/4" />
                                <Skeleton className="h-4 w-1/2" />
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Appointment cards skeleton */}
                <div className="space-y-4">
                    <Skeleton className="h-6 w-40" />
                    {[1, 2, 3].map((i) => (
                        <Card key={i}>
                            <CardContent className="pt-6 space-y-4">
                                <div className="flex items-start justify-between">
                                    <div className="space-y-2 flex-1">
                                        <Skeleton className="h-5 w-3/4" />
                                        <Skeleton className="h-4 w-1/2" />
                                        <Skeleton className="h-4 w-2/3" />
                                    </div>
                                    <Skeleton className="h-6 w-16 rounded-full" />
                                </div>
                                <div className="pt-2">
                                    <Skeleton className="h-10 w-full rounded-lg" />
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            </main>
        </div>
    );
}






