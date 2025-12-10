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

            <main className="flex-1 -mt-12 rounded-t-[2rem] bg-card p-6 space-y-6">
                {/* Current token section skeleton */}
                <div className="bg-gradient-to-br from-primary/10 to-primary/5 rounded-2xl p-6 space-y-4">
                    <Skeleton className="h-5 w-40" />
                    <div className="text-center space-y-3">
                        <Skeleton className="h-16 w-16 rounded-full mx-auto" />
                        <Skeleton className="h-8 w-32 mx-auto" />
                        <Skeleton className="h-5 w-48 mx-auto" />
                    </div>
                </div>

                {/* Queue status skeleton */}
                <div className="bg-card border rounded-xl p-4 space-y-3">
                    <Skeleton className="h-5 w-32" />
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
                </div>

                {/* Instructions skeleton */}
                <div className="space-y-3">
                    <Skeleton className="h-5 w-40" />
                    <div className="space-y-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-3/4" />
                    </div>
                </div>
            </main>
        </div>
    );
}