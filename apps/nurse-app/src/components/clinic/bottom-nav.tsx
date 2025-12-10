
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
    { href: '/appointments', icon: List, label: 'Appointments' },
  ];

  return (
    <nav className="bg-white border-t shadow-inner">
      <div className="flex justify-around items-center h-16 max-w-sm mx-auto">
        {navItems.map((item) => {
          const isActive = pathname === item.href || (item.href === '/' && (pathname.startsWith('/book-appointment') || pathname.startsWith('/walk-in'))) || (item.href === '/dashboard' && pathname.startsWith('/dashboard'));
          return (
            <Link href={item.href} key={item.label}>
              <div
                className={cn(
                  'flex flex-col items-center justify-center text-muted-foreground w-20 h-full transition-colors',
                  isActive && 'text-red-500/50'
                )}
              >
                <item.icon className="h-6 w-6" />
              </div>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
