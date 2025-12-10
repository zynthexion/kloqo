
import React from 'react';

type AppFrameLayoutProps = {
  children: React.ReactNode;
};

export default function AppFrameLayout({ children }: AppFrameLayoutProps) {
  return (
    <div className="flex flex-col h-screen bg-background">
      <main className="flex-1 flex flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}

    