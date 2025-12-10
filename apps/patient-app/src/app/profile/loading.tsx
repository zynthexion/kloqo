'use client';

import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
    return (
        <div className="flex min-h-screen w-full flex-col bg-green-50/50 font-body">
            <header className="flex items-center p-4">
                <Skeleton className="h-10 w-10 rounded-full" />
                <Skeleton className="h-6 w-32 mx-auto" />
                <div className="w-10"></div>
            </header>

            <main className="flex-grow p-4 space-y-6 pb-24">
                {/* Profile header skeleton */}
                <div className="flex items-center gap-4">
                    <Skeleton className="h-20 w-20 rounded-full" />
                    <div className="space-y-2 flex-1">
                        <Skeleton className="h-6 w-48" />
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-4 w-40" />
                    </div>
                </div>

                {/* Settings section skeleton */}
                <div className="bg-card rounded-xl shadow-sm overflow-hidden">
                    <div className="p-4 border-b">
                        <Skeleton className="h-10 w-full" />
                    </div>
                    <div className="p-4 border-b">
                        <Skeleton className="h-10 w-full" />
                    </div>
                    <div className="p-4 border-b">
                        <Skeleton className="h-12 w-full" />
                    </div>
                    <div className="p-4 border-b">
                        <Skeleton className="h-12 w-full" />
                    </div>
                    <div className="p-4">
                        <Skeleton className="h-12 w-full" />
                    </div>
                </div>

                {/* Menu items skeleton */}
                <div className="bg-card rounded-xl shadow-sm overflow-hidden">
                    {[1, 2, 3, 4].map((i) => (
                        <div key={i} className="p-4 border-b last:border-b-0 flex items-center justify-between">
                            <div className="flex items-center gap-4 flex-1">
                                <Skeleton className="h-6 w-6 rounded" />
                                <Skeleton className="h-5 w-32" />
                            </div>
                            <Skeleton className="h-5 w-5 rounded" />
                        </div>
                    ))}
                </div>

                {/* Logout button skeleton */}
                <div className="pt-4">
                    <Skeleton className="h-12 w-full rounded-lg" />
                </div>
            </main>
        </div>
    );
}