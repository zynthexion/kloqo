import * as React from "react"
import { cn } from "@/lib/utils"
import { capitalizeFirstLetter, toUpperCase, capitalizeWords } from "@kloqo/shared-core"

export interface InputProps extends React.ComponentProps<"input"> {
  autoCapitalizeFirst?: boolean
  autoCapitalizeTitle?: boolean
  autoUppercase?: boolean
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, autoCapitalizeFirst, autoCapitalizeTitle, autoUppercase, onChange, ...props }, ref) => {
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (autoCapitalizeFirst) {
        e.target.value = capitalizeFirstLetter(e.target.value)
      }
      if (autoCapitalizeTitle) {
        e.target.value = capitalizeWords(e.target.value)
      }
      if (autoUppercase) {
        e.target.value = toUpperCase(e.target.value)
      }
      onChange?.(e)
    }

    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-md border border-input bg-[#CADEED] px-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className
        )}
        ref={ref}
        onChange={handleChange}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
