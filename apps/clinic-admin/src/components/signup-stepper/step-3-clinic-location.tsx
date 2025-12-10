
'use client';

import { useFormContext } from 'react-hook-form';
import type { SignUpFormData } from '@/app/(public)/signup/page';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '../ui/form';
import { useEffect, useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { Loader2, MapPin } from 'lucide-react';
import { Input } from '../ui/input';

export function Step3ClinicLocation() {
  const { control, watch, setValue, getValues } = useFormContext<SignUpFormData>();
  const latitude = watch('latitude');
  const longitude = watch('longitude');
  const [isAutoFilling, setIsAutoFilling] = useState(false);
  // Use a state that checks if the relevant form fields are already filled to prevent re-fetching
  const [locationAutoFilled, setLocationAutoFilled] = useState(() => {
    const values = getValues();
    return !!(values.addressLine1 || values.city || values.pincode);
  });
  const { toast } = useToast();

  useEffect(() => {
    const autoFillFromLocation = async () => {
      // Only run if coordinates are present and we haven't already filled the form
      if (latitude && longitude && latitude !== 0 && longitude !== 0 && !locationAutoFilled) {
        setIsAutoFilling(true);
        try {
          const response = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}`
          );
          const data = await response.json();
          
          if (data && data.address) {
            const { road, house_number, neighbourhood, suburb, city, town, village, county, state_district, state, postcode } = data.address;
            
            const line1Parts = [house_number, road].filter(Boolean);
            const line2Parts = [neighbourhood, suburb].filter(Boolean);

            setValue('addressLine1', line1Parts.join(' ') || '', { shouldValidate: true });
            setValue('addressLine2', line2Parts.join(', ') || '', { shouldValidate: true });
            setValue('city', city || town || village || '', { shouldValidate: true });
            setValue('district', state_district || county || '', { shouldValidate: true });
            setValue('state', state || '', { shouldValidate: true });
            setValue('pincode', postcode || '', { shouldValidate: true });
            
            setLocationAutoFilled(true);
            toast({
              title: 'Location Auto-filled',
              description: 'Your clinic address has been automatically filled.',
            });
          }
        } catch (error) {
          console.error('Error auto-filling location:', error);
          toast({
            variant: "destructive",
            title: "Auto-fill Failed",
            description: "Could not fetch address details. Please enter manually.",
          });
        } finally {
          setIsAutoFilling(false);
        }
      }
    };

    // Run this effect only once if conditions are met
    autoFillFromLocation();
    
  }, [latitude, longitude, setValue, toast, locationAutoFilled]);

  return (
    <div>
      <p className="text-sm text-muted-foreground">Step 3/7</p>
      <h2 className="text-2xl font-bold mb-1">Clinic Location</h2>
      <p className="text-muted-foreground mb-6">To show clinics on map and assist patients.</p>

      {isAutoFilling && (
        <div className="mb-4 p-3 bg-blue-50 border-l-4 border-blue-400 text-blue-800 rounded flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Auto-filling address from detected location...</span>
        </div>
      )}

      {locationAutoFilled && !isAutoFilling && (
        <div className="mb-4 p-3 bg-green-50 border-l-4 border-green-400 text-green-800 rounded flex items-center gap-2">
          <MapPin className="h-4 w-4" />
          <span>Address has been auto-filled. You can edit it if needed.</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <FormField
          control={control}
          name="addressLine1"
          render={({ field }) => (
            <FormItem className="md:col-span-2">
              <FormLabel>Address Line 1 <span className="text-destructive">*</span></FormLabel>
              <FormControl>
                <Input placeholder="Building Name, Street Name" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="addressLine2"
          render={({ field }) => (
            <FormItem className="md:col-span-2">
              <FormLabel>Address Line 2 (Optional)</FormLabel>
              <FormControl>
                <Input placeholder="Landmark, Area" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="city"
          render={({ field }) => (
            <FormItem>
              <FormLabel>City / Town <span className="text-destructive">*</span></FormLabel>
              <FormControl>
                <Input placeholder="e.g., Kochi" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="district"
          render={({ field }) => (
            <FormItem>
              <FormLabel>District (Optional)</FormLabel>
              <FormControl>
                <Input placeholder="e.g., Ernakulam" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="state"
          render={({ field }) => (
            <FormItem>
              <FormLabel>State <span className="text-destructive">*</span></FormLabel>
              <FormControl>
                <Input placeholder="e.g., Kerala" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="pincode"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Pincode <span className="text-destructive">*</span></FormLabel>
              <FormControl>
                <Input placeholder="e.g., 682016" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="mapsLink"
          render={({ field }) => (
            <FormItem className="md:col-span-2">
              <FormLabel>Google Maps Link (Optional)</FormLabel>
              <FormControl>
                <Input placeholder="https://maps.app.goo.gl/..." {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </div>
  );
}
