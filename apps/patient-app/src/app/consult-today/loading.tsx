'use client';

import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="min-h-screen bg-background pb-24">
      <div className="bg-primary text-primary-foreground p-6 rounded-b-[2rem] pb-20 space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-10 w-10 rounded-full bg-white/30" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3 bg-white/40" />
            <Skeleton className="h-3 w-1/4 bg-white/25" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-28 rounded-2xl bg-white/20" />
          <Skeleton className="h-28 rounded-2xl bg-white/20" />
        </div>

        <Skeleton className="h-12 w-full rounded-full bg-white/20" />
      </div>

      <main className="-mt-12 rounded-t-[2rem] bg-card p-6 space-y-6 shadow-lg">
        <div className="space-y-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-40 w-full" />
        </div>

        <div className="space-y-3">
          <Skeleton className="h-4 w-40" />
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        </div>

        <div className="space-y-3">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-48 w-full rounded-2xl" />
        </div>
      </main>
    </div>
  );
}









