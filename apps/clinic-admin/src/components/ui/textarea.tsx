import * as React from 'react';
import { cn } from '@/lib/utils';
import { capitalizeFirstLetter, capitalizeWords } from '@kloqo/shared-core';

export interface TextareaProps extends React.ComponentProps<'textarea'> {
  autoCapitalizeFirst?: boolean;
  autoCapitalizeTitle?: boolean;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, autoCapitalizeFirst, autoCapitalizeTitle, onChange, ...props }, ref) => {
    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      if (autoCapitalizeFirst) {
        e.target.value = capitalizeFirstLetter(e.target.value);
      }
      if (autoCapitalizeTitle) {
        e.target.value = capitalizeWords(e.target.value);
      }
      onChange?.(e);
    };

    return (
      <textarea
        className={cn(
          'flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          className
        )}
        ref={ref}
        onChange={handleChange}
        {...props}
      />
    );
  }
);
Textarea.displayName = 'Textarea';

export { Textarea };
