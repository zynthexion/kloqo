/**
 * Reusable skeleton components for common loading states
 * Provides consistent loading UI across the app
 */

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Minimal loading skeleton for quick transitions
 */
export function MinimalSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center justify-center p-8", className)}>
      <div className="flex flex-col items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-full" />
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  );
}

/**
 * Page header skeleton
 */
export function PageHeaderSkeleton({ 
  showBack = false,
  className 
}: { 
  showBack?: boolean;
  className?: string;
}) {
  return (
    <header className={cn("flex items-center p-4", className)}>
      {showBack && <Skeleton className="h-10 w-10 rounded-full" />}
      <Skeleton className="h-6 flex-1 mx-4" />
      <div className="w-10"></div>
    </header>
  );
}

/**
 * Profile card skeleton
 */
export function ProfileCardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-4 p-4", className)}>
      <Skeleton className="h-16 w-16 rounded-full" />
      <div className="space-y-2 flex-1">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}

/**
 * Appointment card skeleton
 */
export function AppointmentCardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("bg-card border rounded-xl p-4 space-y-3", className)}>
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
  );
}

/**
 * Doctor card skeleton
 */
export function DoctorCardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("bg-card border rounded-xl p-4 flex items-center gap-4", className)}>
      <Skeleton className="h-16 w-16 rounded-full" />
      <div className="flex-grow space-y-2">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
    </div>
  );
}

/**
 * Full page skeleton with header and content
 */
export function FullPageSkeleton({ 
  showHeader = true,
  headerClassName,
  contentClassName 
}: { 
  showHeader?: boolean;
  headerClassName?: string;
  contentClassName?: string;
}) {
  return (
    <div className="flex min-h-screen w-full flex-col bg-background">
      {showHeader && (
        <div className={cn("bg-primary text-primary-foreground p-6 rounded-b-[2rem] pb-16 space-y-4", headerClassName)}>
          <Skeleton className="h-6 w-40 bg-white/40" />
          <div className="flex items-center gap-3">
            <Skeleton className="h-5 w-5 rounded-full bg-white/30" />
            <Skeleton className="h-4 w-48 bg-white/30" />
          </div>
        </div>
      )}
      <main className={cn("flex-1 p-6 space-y-6", contentClassName)}>
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






