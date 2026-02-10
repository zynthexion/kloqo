'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  TrendingUp,
  Building2,
  Users,
  DollarSign,
  FileText,
  AlertTriangle,
  Activity,
  SlidersHorizontal,
  User,
  CreditCard,
  Bell,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const menuItems = [
  { href: '/dashboard', icon: LayoutDashboard, label: 'Overview' },
  { href: '/dashboard/growth', icon: TrendingUp, label: 'Growth Analytics' },
  { href: '/dashboard/notifications', icon: Bell, label: 'Notifications' },
  { href: '/dashboard/marketing', icon: TrendingUp, label: 'Marketing Analytics' },
  { href: '/dashboard/clinics', icon: Building2, label: 'Clinics' },
  { href: '/dashboard/doctors', icon: User, label: 'Doctors' }, // NEW MENU ITEM
  { href: '/dashboard/patients', icon: Users, label: 'Patients' },
  { href: '/dashboard/financial', icon: DollarSign, label: 'Financial' },
  { href: '/dashboard/reports', icon: FileText, label: 'Reports' },
  { href: '/dashboard/departments', icon: SlidersHorizontal, label: 'Departments' },
  { href: '/dashboard/errors', icon: AlertTriangle, label: 'Error Logs' },
  { href: '/dashboard/health', icon: Activity, label: 'App Health' },
  { href: '/dashboard/plans', icon: CreditCard, label: 'Pricing Plans' },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 bg-white border-r border-gray-200 min-h-screen">
      <div className="p-4">
        <h2 className="text-lg font-bold text-gray-900 mb-6">Kloqo SuperAdmin</h2>
        <nav className="space-y-1">
          {menuItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href || (item.href !== '/dashboard' && pathname?.startsWith(item.href));

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-gray-700 hover:bg-gray-100'
                )}
              >
                <Icon className="h-5 w-5" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}

