'use client';

import { cn } from '@/lib/utils';

type Step = {
  number: number;
  title: string;
  description: string;
};

type StepperNavProps = {
  steps: Step[];
  currentStep: number;
};

export function StepperNav({ steps, currentStep }: StepperNavProps) {
  return (
    <nav>
      <ol className="space-y-4">
        {steps.map((step, index) => (
          <li key={step.number} className="flex items-start">
            <div className="flex flex-col items-center mr-4">
              <div
                className={cn(
                  'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold',
                  currentStep >= step.number
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-gray-300 text-gray-600'
                )}
              >
                {step.number}
              </div>
              {index < steps.length - 1 && (
                <div
                  className={cn(
                    'w-0.5 h-16 mt-2',
                    currentStep > step.number ? 'bg-primary' : 'bg-gray-300'
                  )}
                />
              )}
            </div>
            <div>
              <h4
                className={cn(
                  'font-semibold',
                  currentStep >= step.number ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {step.title}
              </h4>
              <p className="text-sm text-muted-foreground">{step.description}</p>
            </div>
          </li>
        ))}
      </ol>
    </nav>
  );
}