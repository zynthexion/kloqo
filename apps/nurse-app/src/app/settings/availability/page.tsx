'use client';

import AvailabilityManager from '@/components/settings/availability-manager';
import AppFrameLayout from '@/components/layout/app-frame';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function AvailabilityPage() {
    return (
        <AppFrameLayout>
            <div className="flex flex-col h-full">
                <header className="flex items-center gap-4 p-4 border-b">
                    <Link href="/settings">
                        <Button variant="ghost" size="icon">
                            <ArrowLeft />
                        </Button>
                    </Link>
                    <div className="flex-1">
                        <h1 className="text-xl font-bold">Doctor Availability</h1>
                    </div>
                </header>
                 <main className="flex-1 overflow-y-auto">
                    <AvailabilityManager />
                 </main>
            </div>
        </AppFrameLayout>
    )
}