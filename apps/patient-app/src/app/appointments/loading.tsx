'use client';

import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
    return (
        <div className="flex min-h-screen w-full flex-col bg-background font-body pb-24">
            <header className="bg-primary text-primary-foreground p-6 rounded-b-[2rem] pb-20">
                <div className="flex items-center justify-between mb-4">
                    <Skeleton className="h-6 w-32 bg-white/40" />
                    <Skeleton className="h-6 w-6 rounded-full bg-white/30" />
                </div>
                <Skeleton className="h-10 w-48 bg-white/40" />
            </header>

            <main className="flex-1 -mt-12 rounded-t-[2rem] bg-card p-6 space-y-4">
                {/* Tab selector skeleton */}
                <div className="flex gap-2 border-b pb-2">
                    <Skeleton className="h-10 w-24" />
                    <Skeleton className="h-10 w-24" />
                </div>

                {/* Appointment cards skeleton */}
                <div className="space-y-4">
                    {[1, 2, 3].map((i) => (
                        <div key={i} className="bg-card border rounded-xl p-4 space-y-3">
                            <div className="flex items-start justify-between">
                                <div className="space-y-2 flex-1">
                                    <Skeleton className="h-5 w-3/4" />
                                    <Skeleton className="h-4 w-1/2" />
                                </div>
                                <Skeleton className="h-6 w-16 rounded-full" />
                            </div>
                            <div className="flex items-center gap-3">
                                <Skeleton className="h-10 w-10 rounded-full" />
                                <div className="space-y-2 flex-1">
                                    <Skeleton className="h-4 w-2/3" />
                                    <Skeleton className="h-3 w-1/2" />
                                </div>
                            </div>
                            <div className="flex gap-2 pt-2">
                                <Skeleton className="h-9 w-24 rounded-lg" />
                                <Skeleton className="h-9 w-24 rounded-lg" />
                            </div>
                        </div>
                    ))}
                </div>
            </main>
        </div>
    );
}