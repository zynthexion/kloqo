import { type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Button } from "./ui/button";

interface AppLayoutProps {
    children: ReactNode;
    title: string;
    backHref?: string;
}

export function AppLayout({ children, title, backHref }: AppLayoutProps) {
    return (
        <div className="flex min-h-screen w-full flex-col bg-background font-body text-foreground">
            <div className="mx-auto flex h-screen w-full max-w-md flex-col">
                <header className="flex h-16 shrink-0 items-center gap-4 border-b bg-card px-4">
                    {backHref && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" asChild>
                            <Link href={backHref}>
                                <ArrowLeft className="h-5 w-5" />
                                <span className="sr-only">Back</span>
                            </Link>
                        </Button>
                    )}
                    <h1 className="text-xl font-bold font-headline">{title}</h1>
                </header>
                <main className="flex-grow overflow-y-auto p-4 md:p-6">
                    {children}
                </main>
            </div>
        </div>
    );
}
