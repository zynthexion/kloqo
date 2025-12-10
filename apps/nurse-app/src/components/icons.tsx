import { cn } from "@/lib/utils";

export function Logo({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h1 className={cn("font-logo text-3xl font-bold tracking-tight lowercase", className)} {...props}>
      kloqo
    </h1>
  );
}

export function HomeIcon({ className, ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg className={cn("nav-icon", className)} viewBox="0 0 24 24" {...props}>
      <path d="M12 3L2 12h3v8h6v-6h2v6h6v-8h3L12 3z"/>
    </svg>
  );
}

export function LiveIcon({ className, ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg className={cn("nav-icon", className)} viewBox="0 0 24 24" {...props}>
      <path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zm0-2c3.87 0 7 3.13 7 7s-3.13 7-7 7-7-3.13-7-7 3.13-7 7-7zm0-3C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/>
    </svg>
  );
}

export function AppointmentIcon({ className, ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg className={cn("nav-icon", className)} viewBox="0 0 24 24" {...props}>
      <path d="M19,19H5V8H19M16,1V3H8V1H6V3H5C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.89 20.1,3 19,3H18V1M17,12H12V17H17V12Z"/>
    </svg>
  );
}
