import { cn } from '@/lib/utils';

interface ModernSpinnerProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  text?: string;
  className?: string;
}

export function ModernSpinner({ size = 'lg', text, className }: ModernSpinnerProps) {
  const dotSizes = {
    sm: 'w-4 h-4',
    md: 'w-5 h-5',
    lg: 'w-7 h-7',
    xl: 'w-7 h-7'
  };

  const gapSizes = {
    sm: 'gap-4',
    md: 'gap-6',
    lg: 'gap-10',
    xl: 'gap-10'
  };

  const columnGapSizes = {
    sm: 'gap-4',
    md: 'gap-6',
    lg: 'gap-10',
    xl: 'gap-10'
  };

  const Dot = ({ delay }: { delay: number }) => (
    <div
      className={cn(
        "rounded-full bg-[#60896c] opacity-30",
        dotSizes[size]
      )}
      style={{
        animation: 'wave 1.2s ease-in-out infinite',
        animationDelay: `${delay}s`
      }}
    />
  );

  return (
    <div className={cn("flex flex-col items-center justify-center", className)}>
      {/* Main grid */}
      <div className={cn("grid grid-cols-3", gapSizes[size])}>
        {/* Column 1 */}
        <div className={cn("grid grid-rows-4", columnGapSizes[size])}>
          <Dot delay={0} />
          <Dot delay={0.1} />
          <Dot delay={0.2} />
          <Dot delay={0.3} />
        </div>
        
        {/* Column 2 */}
        <div className={cn("grid grid-rows-4", columnGapSizes[size])}>
          <Dot delay={0.15} />
          <Dot delay={0.25} />
          <Dot delay={0.35} />
          <Dot delay={0.45} />
        </div>
        
        {/* Column 3 */}
        <div className={cn("grid grid-rows-4", columnGapSizes[size])}>
          <Dot delay={0.3} />
          <Dot delay={0.4} />
          <Dot delay={0.5} />
          <Dot delay={0.6} />
        </div>
      </div>
    </div>
  );
}

