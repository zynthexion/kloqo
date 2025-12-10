'use client';

import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
    return (
        <div className="min-h-screen flex flex-col bg-background">
            <header className="flex items-center p-4 border-b">
                <Skeleton className="h-10 w-10 rounded-full" />
                <Skeleton className="h-6 flex-1 mx-4" />
                <div className="w-10"></div>
            </header>

            <main className="flex-grow p-6 space-y-5">
                {[1, 2, 3, 4].map((i) => (
                    <section key={i} className="rounded-2xl border bg-card shadow-sm p-5">
                        <div className="flex items-start gap-3">
                            <Skeleton className="h-9 w-9 rounded-full" />
                            <div className="space-y-2 flex-1">
                                <Skeleton className="h-5 w-32" />
                                <Skeleton className="h-4 w-full" />
                                <Skeleton className="h-4 w-3/4" />
                            </div>
                        </div>
                    </section>
                ))}
            </main>
        </div>
    );
}






