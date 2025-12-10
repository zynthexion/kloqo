'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';

function DoctorSkeleton() {
    return (
        <Card>
            <CardContent className="p-4 flex items-center gap-4">
                <Skeleton className="w-16 h-16 rounded-full" />
                <div className="flex-grow space-y-2">
                    <Skeleton className="h-5 w-3/4" />
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-5 w-20 rounded-full" />
                </div>
            </CardContent>
        </Card>
    );
}

export default function Loading() {
    return (
        <div className="flex min-h-screen w-full flex-col bg-background font-body">
            <div className="flex items-center p-4 border-b">
                <Button 
                    variant="ghost" 
                    size="icon" 
                    className="h-8 w-8"
                    disabled
                >
                    <ArrowLeft className="h-5 w-5" />
                </Button>
                <Skeleton className="h-6 w-32 ml-4" />
                <div className="w-8"></div>
            </div>
            <div className="p-6 space-y-4">
                <DoctorSkeleton />
                <DoctorSkeleton />
                <DoctorSkeleton />
            </div>
        </div>
    );
}






