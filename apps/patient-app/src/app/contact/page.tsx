'use client';

import Link from 'next/link';
import { ArrowLeft, MapPin, Mail, Phone, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AuthGuard } from '@/components/auth-guard';

const address = `Suite No. A96, Door No. 63/700, D Space, 6th Floor, Sky Tower,
Mavoor Road Junction, Bank Road, Kozhikode-673001`;

const whatsappNumber = '+919496097611';
const whatsappLink = `https://wa.me/${whatsappNumber.replace('+', '')}`;

function ContactPage() {
    const cards = [
        {
            icon: MapPin,
            title: 'Office Address',
            content: (
                <p className="text-sm text-muted-foreground whitespace-pre-line">
                    ZYNTHEXION TECHNOLOGIES PRIVATE LIMITED
                    {'\n'}
                    {address}
                </p>
            ),
        },
        {
            icon: Mail,
            title: 'Email',
            content: (
                <Link href="mailto:info@zynthexion.com" className="text-primary font-medium">
                    info@zynthexion.com
                </Link>
            ),
        },
        {
            icon: Phone,
            title: 'Phone',
            content: (
                <Link href="tel:+919496097611" className="text-primary font-medium">
                    +91 94960 97611
                </Link>
            ),
        },
        {
            icon: MessageCircle,
            title: 'WhatsApp',
            content: (
                <Link href={whatsappLink} className="text-primary font-medium" target="_blank">
                    Chat on WhatsApp
                </Link>
            ),
        },
    ];

    return (
        <div className="min-h-screen flex flex-col bg-background">
            <header className="flex items-center p-4 border-b">
                <Button variant="ghost" size="icon" className="h-9 w-9" asChild>
                    <Link href="/profile">
                        <ArrowLeft className="h-5 w-5" />
                        <span className="sr-only">Back</span>
                    </Link>
                </Button>
                <h1 className="text-xl font-bold text-center flex-grow">Contact Us</h1>
                <div className="w-9" />
            </header>

            <main className="flex-grow p-6 space-y-5">
                {cards.map((card, index) => (
                    <section key={index} className="rounded-2xl border bg-card shadow-sm p-5">
                        <div className="flex items-start gap-3">
                            <div className="rounded-full bg-primary/10 p-2">
                                <card.icon className="h-5 w-5 text-primary" />
                            </div>
                            <div className="space-y-1">
                                <p className="font-semibold">{card.title}</p>
                                {card.content}
                            </div>
                        </div>
                    </section>
                ))}
            </main>
        </div>
    );
}

function ContactPageWithAuth() {
    return (
        <AuthGuard>
            <ContactPage />
        </AuthGuard>
    );
}

export default ContactPageWithAuth;


