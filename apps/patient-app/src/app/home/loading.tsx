'use client';

import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex min-h-screen flex-col bg-card">
      <div className="bg-primary text-primary-foreground p-6 rounded-b-[2rem] pb-16 space-y-4">
        <Skeleton className="h-6 w-40 bg-white/40" />
        <div className="flex items-center gap-3">
          <Skeleton className="h-5 w-5 rounded-full bg-white/30" />
          <Skeleton className="h-4 w-48 bg-white/30" />
        </div>
        <Skeleton className="h-12 w-full bg-white/20 rounded-2xl" />
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-32 w-full bg-white/20 rounded-2xl" />
          <Skeleton className="h-32 w-full bg-white/20 rounded-2xl" />
        </div>
      </div>
      <main className="flex-1 bg-background -mt-12 rounded-t-[2rem] p-6 space-y-6">
        <Skeleton className="h-6 w-32" />
        <div className="space-y-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </main>
    </div>
  );
}
