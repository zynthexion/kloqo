
import AppFrameLayout from '@/components/layout/app-frame';
import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import PatientRegistrationForm from './form';


export default function PatientRegistrationPage() {
  return (
    <AppFrameLayout>
       <Suspense fallback={
         <div className="w-full h-full flex flex-col items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin" />
         </div>
       }>
          <PatientRegistrationForm />
       </Suspense>
    </AppFrameLayout>
  );
}
