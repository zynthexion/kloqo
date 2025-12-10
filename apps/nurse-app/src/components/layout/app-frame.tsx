
import BottomNav from '@/components/clinic/bottom-nav';
import { cn } from '@/lib/utils';
import HomePage from '@/components/clinic/home-page';

type AppFrameLayoutProps = {
  children: React.ReactNode;
  className?: string;
  showBottomNav?: boolean;
};

export default function AppFrameLayout({ children, className, showBottomNav = false }: AppFrameLayoutProps) {
  
  const isHomePage = (children as React.ReactElement)?.type === HomePage;

  return (
    <main className="flex min-h-screen flex-col items-center justify-start bg-white md:p-4">
      <div className={cn("w-full h-screen md:h-[800px] md:max-w-sm md:rounded-3xl md:border-4 md:border-gray-800 md:shadow-2xl overflow-hidden bg-card flex flex-col", className)}>
        <div className="flex-1 flex flex-col min-h-0">
          {children}
        </div>
        {showBottomNav && (
            <div className="mt-auto">
                <BottomNav />
            </div>
        )}
      </div>
    </main>
  );
}
