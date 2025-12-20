
"use client"

import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> & {
    labelOn?: string;
    labelOff?: string;
  }
>(({ className, labelOn = "IN", labelOff = "OUT", ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer relative inline-flex h-8 w-20 shrink-0 cursor-pointer items-center rounded-full border-2 border-white shadow-inner transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-[#6FB293] data-[state=unchecked]:bg-[#F69697]",
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block h-7 w-7 rounded-full bg-white shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-12 data-[state=unchecked]:translate-x-0.5"
      )}
    />
    <span className="absolute left-4 text-white font-bold text-sm">
      {props.checked ? labelOn : ''}
    </span>
    <span className="absolute right-3 text-white font-bold text-sm">
      {props.checked ? '' : labelOff}
    </span>
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
