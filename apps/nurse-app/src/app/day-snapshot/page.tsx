
'use client';

import AppFrameLayout from "@/components/layout/app-frame";
import DaySnapshotView from "@/components/clinic/day-snapshot-view";

export default function DaySnapshotPage() {
    return (
        <AppFrameLayout showBottomNav>
            <DaySnapshotView />
        </AppFrameLayout>
    );
}
