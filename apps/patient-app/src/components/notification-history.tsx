'use client';

import { useState, useEffect } from 'react';
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetTrigger
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Bell, Calendar, Clock, Info, CheckCircle2, User, AlertCircle, RefreshCw } from 'lucide-react';
import { useFirebase } from '@/firebase/provider';
import { useUser } from '@/firebase/auth/use-user';
import { collection, query, orderBy, limit, onSnapshot, updateDoc, doc, where, getDocs, writeBatch } from 'firebase/firestore';
import { formatDistanceToNow } from 'date-fns';
import { Skeleton } from '@/components/ui/skeleton';
import { useLanguage } from '@/contexts/language-context';

export function NotificationHistory() {
    const [open, setOpen] = useState(false);
    const [notifications, setNotifications] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [unreadCount, setUnreadCount] = useState(0);
    const { firestore } = useFirebase() || {};
    const { user } = useUser();
    const { language } = useLanguage();

    useEffect(() => {
        if (!firestore || !user?.uid) return;

        // Load recent notifications
        const q = query(
            collection(firestore, 'users', user.uid, 'notifications'),
            orderBy('createdAt', 'desc'),
            limit(20)
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const notes = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                // Convert timestamp to Date object if needed
                createdAt: doc.data().createdAt?.toDate ? doc.data().createdAt.toDate() : new Date(doc.data().timestamp || Date.now())
            }));
            setNotifications(notes);

            // Calculate unread count
            const unread = notes.filter((n: any) => !n.read).length;
            setUnreadCount(unread);

            setLoading(false);
        });

        return () => unsubscribe();
    }, [firestore, user?.uid]);

    const markAllAsRead = async () => {
        if (!firestore || !user?.uid || notifications.length === 0) return;

        const batch = writeBatch(firestore);
        const unreadNotes = notifications.filter(n => !n.read);

        if (unreadNotes.length === 0) return;

        unreadNotes.forEach(note => {
            const ref = doc(firestore, 'users', user.uid, 'notifications', note.id);
            batch.update(ref, { read: true });
        });

        await batch.commit();
    };

    const handleOpenChange = (isOpen: boolean) => {
        setOpen(isOpen);
        if (isOpen) {
            markAllAsRead();
        }
    };

    const getIcon = (type: string) => {
        switch (type) {
            case 'appointment_confirmed': return <CheckCircle2 className="h-5 w-5 text-green-500" />;
            case 'appointment_reminder': return <Clock className="h-5 w-5 text-blue-500" />;
            case 'appointment_cancelled': return <AlertCircle className="h-5 w-5 text-red-500" />;
            case 'token_called': return <User className="h-5 w-5 text-purple-500" />;
            case 'doctor_late': return <Clock className="h-5 w-5 text-orange-500" />;
            case 'appointment_rescheduled': return <RefreshCw className="h-5 w-5 text-yellow-500" />;
            default: return <Info className="h-5 w-5 text-gray-500" />;
        }
    };

    return (
        <Sheet open={open} onOpenChange={handleOpenChange}>
            <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="relative">
                    <Bell className="h-6 w-6" />
                    {unreadCount > 0 && (
                        <span className="absolute top-1 right-1 h-3 w-3 rounded-full bg-red-600 border-2 border-background" />
                    )}
                </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[85vw] sm:max-w-[400px] p-0 flex flex-col h-full bg-white">
                <SheetHeader className="p-4 border-b">
                    <SheetTitle className="text-left flex items-center gap-2">
                        <Bell className="h-5 w-5" />
                        {language === 'ml' ? 'അറിയിപ്പുകൾ' : 'Notifications'}
                    </SheetTitle>
                </SheetHeader>

                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {loading ? (
                        Array(3).fill(0).map((_, i) => (
                            <div key={i} className="flex gap-4 p-3 border rounded-lg">
                                <Skeleton className="h-10 w-10 rounded-full" />
                                <div className="space-y-2 flex-1">
                                    <Skeleton className="h-4 w-3/4" />
                                    <Skeleton className="h-3 w-1/2" />
                                </div>
                            </div>
                        ))
                    ) : notifications.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-40 text-muted-foreground text-center">
                            <Bell className="h-12 w-12 mb-2 opacity-20" />
                            <p>{language === 'ml' ? 'അറിയിപ്പുകളൊന്നും ഇല്ല' : 'No notifications yet'}</p>
                        </div>
                    ) : (
                        notifications.map((note) => (
                            <div
                                key={note.id}
                                className={`flex gap-3 p-3 rounded-lg border ${!note.read ? 'bg-blue-50 border-blue-100' : 'bg-white border-gray-100'}`}
                            >
                                <div className="mt-1 flex-shrink-0">
                                    {getIcon(note.data?.type || 'default')}
                                </div>
                                <div className="flex-1 space-y-1">
                                    <h4 className={`text-sm ${!note.read ? 'font-semibold text-blue-900' : 'font-medium text-gray-900'}`}>
                                        {note.title}
                                    </h4>
                                    <p className="text-xs text-gray-600 leading-snug">
                                        {note.body}
                                    </p>
                                    <p className="text-[10px] text-gray-400 mt-1">
                                        {formatDistanceToNow(note.createdAt, { addSuffix: true })}
                                    </p>
                                </div>
                                {!note.read && (
                                    <div className="mt-2 h-2 w-2 rounded-full bg-blue-500 flex-shrink-0" />
                                )}
                            </div>
                        ))
                    )}
                </div>
            </SheetContent>
        </Sheet>
    );
}
