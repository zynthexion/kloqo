import ClinicDashboard from "@/components/clinic/dashboard";
import AppFrameLayout from "@/components/layout/app-frame";

export default function AppointmentsPage() {
  return (
    <AppFrameLayout showBottomNav>
      <ClinicDashboard />
    </AppFrameLayout>
  );
}

