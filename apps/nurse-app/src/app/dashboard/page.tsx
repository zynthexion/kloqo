import LiveDashboard from "@/components/clinic/live-dashboard";
import AppFrameLayout from "@/components/layout/app-frame";

export default function DashboardPage() {
  return (
    <AppFrameLayout showBottomNav>
      <LiveDashboard />
    </AppFrameLayout>
  );
}
