
'use client';

import { useFormContext } from 'react-hook-form';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import type { SignUpFormData } from '@/app/(public)/signup/page';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '../ui/form';
import { Rocket } from 'lucide-react';

const plans = [
    {
        name: 'Free Plan (Beta)',
        doctors: 'For testing & feedback',
        price: 'Free',
        roi: 'Provide valuable feedback to help us improve Kloqo for everyone.'
    },
];

export function Step5Pricing() {
  const { control, watch } = useFormContext<SignUpFormData>();
  const plan = watch('plan');
  const isFree = plan === 'Free Plan (Beta)';

  return (
    <div>
      <p className="text-sm text-muted-foreground">Step 5/7</p>
      <h2 className="text-2xl font-bold mb-1">Pricing & Payment</h2>
      <p className="text-muted-foreground mb-6">Choose a plan that fits your clinic's needs.</p>
      
      <div className="space-y-6">
        <FormField
          control={control}
          name="plan"
          render={({ field }) => (
            <FormItem className="space-y-3">
               <FormLabel className="font-semibold">Choose Your Plan <span className="text-destructive">*</span></FormLabel>
                <FormControl>
                    <RadioGroup
                        onValueChange={field.onChange}
                        value={field.value}
                        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4"
                    >
                        {plans.map(p => (
                            <FormItem key={p.name}>
                                <FormControl>
                                    <RadioGroupItem value={p.name} id={p.name} className="sr-only" />
                                </FormControl>
                                <Label 
                                  htmlFor={p.name} 
                                  className={`flex flex-col p-4 border rounded-lg h-full transition-all cursor-pointer hover:border-primary ${
                                    field.value === p.name
                                      ? 'bg-primary text-primary-foreground border-primary shadow-lg'
                                      : 'bg-white border-gray-200'
                                  }`}
                                >
                                    <div className="text-center">
                                        <span className="text-lg font-bold">{p.name}</span>
                                        <p className={`text-sm ${field.value === p.name ? 'text-primary-foreground/90' : 'text-muted-foreground'}`}>
                                          {p.doctors}
                                        </p>
                                    </div>
                                    <div className="text-center my-4">
                                      <span className="text-3xl font-bold">{p.price}</span>
                                    </div>
                                    <p className={`text-xs text-center flex-grow ${field.value === p.name ? 'text-primary-foreground/90' : 'text-muted-foreground'}`}>
                                      {p.roi}
                                    </p>
                                </Label>
                            </FormItem>
                        ))}
                         <div className="flex flex-col items-center justify-center p-4 border-2 border-dashed rounded-lg h-full text-center text-muted-foreground">
                            <Rocket className="h-8 w-8 mb-2" />
                            <p className="font-semibold">More Plans</p>
                            <p className="text-sm">Coming Soon!</p>
                        </div>
                    </RadioGroup>
                </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {plan && !isFree && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 border-t pt-6 animate-in fade-in">
            <FormField
              control={control}
              name="promoCode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Promo Code (optional)</FormLabel>
                  <FormControl>
                    <Input placeholder="KLOQO2025" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name="paymentMethod"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Payment Method (optional)</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select payment method" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="Card">Card</SelectItem>
                      <SelectItem value="UPI">UPI</SelectItem>
                      <SelectItem value="NetBanking">NetBanking</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        )}
      </div>
    </div>
  );
}
