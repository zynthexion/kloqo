
import AppFrameLayout from '@/components/layout/app-frame';
import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import AppointmentDetailsForm from './details-form';


export default function AppointmentDetailsPage() {
  return (
    <AppFrameLayout>
       <Suspense fallback={
         <div className="w-full h-full flex flex-col items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="mt-2 text-muted-foreground">Loading booking details...</p>
         </div>
       }>
          <AppointmentDetailsForm />
       </Suspense>
    </AppFrameLayout>
  );
}
