'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';

export default function Loading() {
    return (
        <div className="flex min-h-screen w-full flex-col bg-background font-body pb-24">
            <header className="bg-primary text-primary-foreground p-6 rounded-b-[2rem] pb-20 space-y-4">
                <Skeleton className="h-6 w-32 bg-white/40" />
                <Skeleton className="h-10 w-full bg-white/20 rounded-full" />
            </header>

            <main className="flex-1 -mt-12 rounded-t-[2rem] bg-card p-6 space-y-4">
                {/* Clinic cards skeleton */}
                {[1, 2, 3, 4].map((i) => (
                    <Card key={i}>
                        <CardContent className="p-4 space-y-3">
                            <div className="flex items-start gap-4">
                                <Skeleton className="h-20 w-20 rounded-xl flex-shrink-0" />
                                <div className="flex-1 space-y-2">
                                    <Skeleton className="h-6 w-3/4" />
                                    <Skeleton className="h-4 w-1/2" />
                                    <div className="flex items-center gap-2">
                                        <Skeleton className="h-4 w-4 rounded-full" />
                                        <Skeleton className="h-4 w-32" />
                                    </div>
                                </div>
                            </div>
                            <div className="flex gap-2 pt-2">
                                <Skeleton className="h-8 w-20 rounded-full" />
                                <Skeleton className="h-8 w-24 rounded-full" />
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </main>
        </div>
    );
}






