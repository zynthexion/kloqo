'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';

export default function Loading() {
    return (
        <div className="flex min-h-screen w-full flex-col bg-[hsl(var(--app-background))] font-body pb-24">
            <header className="flex items-center p-4 gap-2 border-b">
                <Skeleton className="h-10 w-10 rounded-full" />
                <Skeleton className="h-6 flex-1" />
                <div className="w-10"></div>
            </header>

            <main className="flex-1 p-4 md:p-6 space-y-6">
                {/* Current token display skeleton */}
                <Card className="bg-gradient-to-br from-primary/10 to-primary/5">
                    <CardContent className="pt-6 space-y-4">
                        <div className="text-center space-y-3">
                            <Skeleton className="h-20 w-20 rounded-full mx-auto" />
                            <Skeleton className="h-10 w-32 mx-auto" />
                            <Skeleton className="h-5 w-48 mx-auto" />
                            <Skeleton className="h-4 w-64 mx-auto" />
                        </div>
                    </CardContent>
                </Card>

                {/* Appointment details skeleton */}
                <Card>
                    <CardContent className="pt-6 space-y-4">
                        <Skeleton className="h-6 w-40" />
                        <div className="space-y-3">
                            <div className="flex justify-between">
                                <Skeleton className="h-4 w-24" />
                                <Skeleton className="h-4 w-32" />
                            </div>
                            <div className="flex justify-between">
                                <Skeleton className="h-4 w-28" />
                                <Skeleton className="h-4 w-24" />
                            </div>
                            <div className="flex justify-between">
                                <Skeleton className="h-4 w-32" />
                                <Skeleton className="h-4 w-20" />
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Queue status skeleton */}
                <Card>
                    <CardContent className="pt-6 space-y-4">
                        <Skeleton className="h-6 w-32" />
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Skeleton className="h-4 w-20" />
                                <Skeleton className="h-8 w-16" />
                            </div>
                            <div className="space-y-2">
                                <Skeleton className="h-4 w-24" />
                                <Skeleton className="h-8 w-20" />
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Family appointments skeleton */}
                <div className="space-y-3">
                    <Skeleton className="h-6 w-40" />
                    <div className="space-y-3">
                        <Card>
                            <CardContent className="pt-6">
                                <Skeleton className="h-20 w-full" />
                            </CardContent>
                        </Card>
                        <Card>
                            <CardContent className="pt-6">
                                <Skeleton className="h-20 w-full" />
                            </CardContent>
                        </Card>
                    </div>
                </div>
            </main>
        </div>
    );
}






