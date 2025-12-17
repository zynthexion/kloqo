'use client';

import { useState, useEffect } from 'react';
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
    SheetDescription
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Bell, Calendar, Clock, Info, CheckCircle2, User, AlertCircle, RefreshCw, Trash2 } from 'lucide-react';
import { useFirebase } from '@/firebase/provider';
import { useUser } from '@/firebase/auth/use-user';
import { collection, query, orderBy, limit, onSnapshot, updateDoc, doc, where, getDocs, writeBatch, deleteDoc } from 'firebase/firestore';
import { formatDistanceToNow } from 'date-fns';
import { Skeleton } from '@/components/ui/skeleton';
import { useLanguage } from '@/contexts/language-context';

// Sub-component for Swipeable Notification
const SwipeableNotification = ({ note, onMarkRead, onDelete, getIcon }: any) => {
    const [startX, setStartX] = useState<number | null>(null);
    const [currentX, setCurrentX] = useState(0);
    const [isDeleting, setIsDeleting] = useState(false);

    const handleTouchStart = (e: React.TouchEvent) => {
        setStartX(e.touches[0].clientX);
    };

    const handleTouchMove = (e: React.TouchEvent) => {
        if (startX === null) return;
        const diff = e.touches[0].clientX - startX;
        // Only allow swiping left (negative X)
        if (diff < 0) {
            setCurrentX(diff);
        }
    };

    const handleTouchEnd = () => {
        if (currentX < -100) {
            // Threshold met - delete
            setIsDeleting(true);
            onDelete(note.id);
        } else {
            // Reset
            setCurrentX(0);
        }
        setStartX(null);
    };

    const opacity = Math.max(0, 1 + currentX / 200); // Fade out as you swipe

    if (isDeleting) return null;

    return (
        <div className="relative overflow-hidden mb-3 rounded-lg">
            {/* Background (Delete Action) */}
            <div className="absolute inset-0 bg-red-500 flex items-center justify-end pr-4 rounded-lg">
                <Trash2 className="text-white h-5 w-5" />
            </div>

            {/* Foreground (Actual Content) */}
            <div
                className={`relative bg-white flex gap-3 p-3 rounded-lg border transition-transform duration-200 ease-out ${!note.read ? 'bg-blue-50 border-blue-100' : 'border-gray-100'}`}
                style={{ transform: `translateX(${currentX}px)`, opacity }}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                onClick={onMarkRead}
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
        </div>
    );
};

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { useRouter } from 'next/navigation';

export function NotificationHistory() {
    const [open, setOpen] = useState(false);
    const [showClearConfirm, setShowClearConfirm] = useState(false);
    const [notifications, setNotifications] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [unreadCount, setUnreadCount] = useState(0);
    const { firestore } = useFirebase() || {};
    const { user } = useUser();
    const { language } = useLanguage();
    const router = useRouter();

    console.log('🔔 [HISTORY-RENDER] Component Rendered. Auth User:', user ? user.uid : 'NULL');
    console.log('🔔 [HISTORY-RENDER] Current Notifications State:', notifications.length);

    useEffect(() => {
        if (!firestore || !user?.uid) {
            console.log('🔔 [HISTORY-DEBUG] Missing firestore or user', { firestore: !!firestore, userId: user?.uid });
            return;
        }

        // Verify we are talking to the right project
        console.log('🔔 [HISTORY-DEBUG] Firestore Project ID:', firestore.app.options.projectId);

        console.log(`🔔 [HISTORY-DEBUG] Listening to users/${user.uid}/notifications`);
        const notificationsRef = collection(firestore, 'users', user.uid, 'notifications');

        // TEMPORARY DEBUG: Removing ordering to rule out index issues
        // const q = query(notificationsRef, orderBy('createdAt', 'desc'), limit(50));
        const q = query(notificationsRef, orderBy('createdAt', 'desc'), limit(50));

        const unsubscribe = onSnapshot(q, (snapshot) => {
            console.log(`🔔 [HISTORY-DEBUG] Snapshot received. Docs: ${snapshot.size}`);
            const newNotifications = snapshot.docs.map(doc => {
                const data = doc.data();
                // DEBUG: Log first notification to see structure
                if (snapshot.docs.indexOf(doc) === 0) {
                    console.log('🔔 [HISTORY-DEBUG] Sample Notification Data:', { id: doc.id, ...data });
                }
                return {
                    id: doc.id,
                    ...data,
                    // Handle serverTimestamp which might be null immediately after write
                    createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(),
                    timestamp: data.timestamp || Date.now()
                };
            });
            console.log(`🔔 [HISTORY-DEBUG] Processed ${newNotifications.length} notifications for user ${user.uid}`);
            setNotifications(newNotifications);


            const unread = newNotifications.filter((n: any) => !n.read).length;
            setUnreadCount(unread);
            setLoading(false);
        }, (error) => {
            console.error("🔔 Error fetching notifications:", error);
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

    const handleClearAllClick = () => {
        setShowClearConfirm(true);
    };

    const handleConfirmClear = async () => {
        if (!firestore || !user?.uid) return;

        setLoading(true);
        const batch = writeBatch(firestore);
        notifications.forEach(note => {
            const ref = doc(firestore, 'users', user.uid, 'notifications', note.id);
            batch.delete(ref);
        });
        await batch.commit();
        setLoading(false);
        setShowClearConfirm(false);
    };

    const handleDeleteOne = async (id: string) => {
        if (!firestore || !user?.uid) return;
        await deleteDoc(doc(firestore, 'users', user.uid, 'notifications', id));
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
                    <div className='flex justify-between items-center mr-6'>
                        <SheetTitle className="text-left flex items-center gap-2">
                            <Bell className="h-5 w-5" />
                            {language === 'ml' ? 'അറിയിപ്പുകൾ' : 'Notifications'}
                        </SheetTitle>
                        {notifications.length > 0 && (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="text-red-500 hover:text-red-700 hover:bg-red-50 text-xs h-8 px-2"
                                onClick={handleClearAllClick}
                            >
                                {language === 'ml' ? 'എല്ലാം മായ്ക്കുക' : 'Clear All'}
                            </Button>
                        )}
                    </div>
                    <SheetDescription className="text-left text-xs text-muted-foreground">
                        {language === 'ml' ? 'നിങ്ങളുടെ സമീപകാല അപ്‌ഡേറ്റുകളും സന്ദേശങ്ങളും ഇവിടെ കാണാം' : 'View your recent updates and messages here'}
                    </SheetDescription>
                </SheetHeader>

                <div className="flex-1 overflow-y-auto p-4">
                    {loading ? (
                        Array(3).fill(0).map((_, i) => (
                            <div key={i} className="flex gap-4 p-3 border rounded-lg mb-3">
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
                            <SwipeableNotification
                                key={note.id}
                                note={note}
                                getIcon={getIcon}
                                onMarkRead={() => { }} // Already marked on open
                                onDelete={handleDeleteOne}
                            />
                        ))
                    )}
                </div>
            </SheetContent>

            <AlertDialog open={showClearConfirm} onOpenChange={setShowClearConfirm}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {language === 'ml' ? 'എല്ലാ അറിയിപ്പുകളും മായ്ക്കണോ?' : 'Delete all notifications?'}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {language === 'ml'
                                ? 'ഈ പ്രവർത്തനം പഴയപടിയാക്കാൻ കഴിയില്ല. ഇത് നിങ്ങളുടെ എല്ലാ അറിയിപ്പുകളും ശാശ്വതമായി നീക്കം ചെയ്യും.'
                                : 'This action cannot be undone. This will permanently remove all your notifications.'}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>
                            {language === 'ml' ? 'റദ്ദാക്കുക' : 'Cancel'}
                        </AlertDialogCancel>
                        <AlertDialogAction onClick={handleConfirmClear} className="bg-red-600 hover:bg-red-700">
                            {language === 'ml' ? 'മായ്ക്കുക' : 'Delete All'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Sheet>
    );
}
