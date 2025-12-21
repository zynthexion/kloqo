'use client';

import Link from 'next/link';
import { Home, Calendar, User, Radio } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePathname, useRouter } from 'next/navigation';
import { useLanguage } from '@/contexts/language-context';
import { useEffect } from 'react';

const navItems = [
    { href: '/home', icon: Home, key: 'home' },
    { href: '/appointments', icon: Calendar, key: 'appointments' },
    { href: '/live-token', icon: Radio, key: 'live' },
    { href: '/profile', icon: User, key: 'profile' },
];

export function BottomNav() {
    const pathname = usePathname();
    const router = useRouter();
    const { t } = useLanguage();

    // Prefetch all navigation pages on mount for instant navigation
    useEffect(() => {
        navItems.forEach(item => {
            router.prefetch(item.href);
        });
    }, [router]);

    const labels = {
        home: t.navigation.home,
        appointments: t.navigation.appointments,
        live: t.navigation.live,
        profile: t.navigation.profile,
    };

    return (
        <footer className="fixed bottom-0 left-0 right-0 w-full bg-card border-t pb-safe z-50 hide-on-wa">
            <nav className="mx-auto flex max-w-md items-center justify-around h-20 pb-4">
                {navItems.map((item) => (
                    <Link
                        key={item.href}
                        href={item.href}
                        prefetch={true}
                        className={cn(
                            "flex flex-col items-center justify-center text-muted-foreground hover:text-primary transition-colors w-20",
                            pathname.startsWith(item.href) && "text-primary"
                        )}
                    >
                        <div className={cn("p-3 rounded-xl", pathname.startsWith(item.href) ? "bg-primary text-primary-foreground" : "")}>
                            <item.icon className="h-7 w-7" />
                        </div>
                        {!pathname.startsWith(item.href) && <span className="text-sm mt-1 font-medium">{labels[item.key as keyof typeof labels]}</span>}
                    </Link>
                ))}
            </nav>
        </footer>
    );
}

