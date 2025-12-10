
'use client';

import { ArrowLeft, LogOut, ChevronRight, CalendarDays, CalendarX, Settings } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import AppFrameLayout from '@/components/layout/app-frame';
import { useToast } from '@/hooks/use-toast';

export default function SettingsPage() {
  const router = useRouter();
  const { toast } = useToast();

  const handleLogout = () => {
    localStorage.removeItem('user');
    localStorage.removeItem('selectedDoctorId');
    localStorage.removeItem('clinicStatus');
    toast({
      title: "Logged Out",
      description: "You have been successfully logged out.",
    });
    router.push('/login');
  };

  const menuItems = [
      {
          title: "Doctor Availability",
          icon: CalendarDays,
          href: "/settings/availability",
          color: "text-blue-600"
      },
      {
          title: "Clinic Settings",
          icon: Settings,
          href: "/settings/clinic",
          color: "text-purple-600"
      },
      {
          title: "Log Out",
          icon: LogOut,
          action: handleLogout,
          color: "text-destructive"
      }
  ]

  return (
    <AppFrameLayout>
      <div className="flex flex-col h-full">
         <header className="flex items-center gap-4 p-4 border-b">
            <Link href="/">
                <Button variant="ghost" size="icon">
                    <ArrowLeft />
                </Button>
            </Link>
            <div className="flex-1">
                <h1 className="text-xl font-bold">Settings</h1>
            </div>
        </header>
        <main className="flex-1 p-6 space-y-4">
             {menuItems.map((item) => (
                 item.href ? (
                    <Link href={item.href} key={item.title}>
                        <div
                            className="flex items-center justify-between p-4 rounded-lg cursor-pointer bg-card hover:bg-muted/50"
                        >
                            <div className="flex items-center gap-4">
                                <item.icon className={`h-5 w-5 ${item.color}`} />
                                <span className="font-medium">{item.title}</span>
                            </div>
                            <ChevronRight className="h-5 w-5 text-muted-foreground" />
                        </div>
                    </Link>
                 ) : (
                    <div
                        key={item.title}
                        className="flex items-center justify-between p-4 rounded-lg cursor-pointer bg-card hover:bg-muted/50"
                        onClick={item.action}
                    >
                        <div className="flex items-center gap-4">
                            <item.icon className={`h-5 w-5 ${item.color}`} />
                            <span className="font-medium">{item.title}</span>
                        </div>
                    </div>
                 )
             ))}
        </main>
      </div>
    </AppFrameLayout>
  );
}
