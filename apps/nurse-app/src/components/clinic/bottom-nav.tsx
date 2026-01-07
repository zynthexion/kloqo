
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Home, List, Radio } from 'lucide-react';

export default function BottomNav() {
  const pathname = usePathname();

  const navItems = [
    { href: '/', icon: Home, label: 'Home' },
    { href: '/dashboard', icon: Radio, label: 'Live' },
    { href: '/appointments', icon: List, label: 'Bookings' },
  ];

  return (
    <nav className="bg-white border-t border-slate-200 shadow-sm safe-area-pb">
      <div className="flex justify-around items-center h-16 max-w-md mx-auto px-6">
        {navItems.map((item) => {
          const isActive = pathname === item.href || (item.href === '/' && (pathname.startsWith('/book-appointment') || pathname.startsWith('/walk-in'))) || (item.href === '/dashboard' && pathname.startsWith('/dashboard'));
          return (
            <Link href={item.href} key={item.label} className="flex-1">
              <div
                className={cn(
                  'flex flex-col items-center justify-center gap-1 transition-all duration-200',
                  isActive ? 'text-theme-blue scale-110' : 'text-slate-400 hover:text-slate-600'
                )}
              >
                <item.icon className={cn("h-6 w-6", isActive && "stroke-[2.5px]")} />
                <span className={cn("text-[10px] font-bold uppercase tracking-wider", isActive ? "opacity-100" : "opacity-70")}>
                  {item.label}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
