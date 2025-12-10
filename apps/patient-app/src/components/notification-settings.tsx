'use client';

import { useState, useEffect } from 'react';
import { Bell, BellOff, Loader2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { requestNotificationPermission, getFCMToken, isNotificationEnabled } from '@/lib/firebase-messaging';
import { useUser } from '@/firebase/auth/use-user';
import { useLanguage } from '@/contexts/language-context';
import { useFirebase } from '@/firebase/provider';
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { Patient } from '@/lib/types';
import useSWR, { mutate } from 'swr';

export function NotificationSettings() {
    const [notificationsEnabled, setNotificationsEnabled] = useState(false);
    const [loading, setLoading] = useState(false);
    const [isMounted, setIsMounted] = useState(false);
    const [primaryUserId, setPrimaryUserId] = useState<string | null>(null);
    const { toast } = useToast();
    const { user } = useUser();
    const { firestore } = useFirebase() || {};
    const { t } = useLanguage();
    const notifTexts = t.profile.notificationToasts;

    useEffect(() => {
        setIsMounted(true);
    }, []);

    // Get primaryUserId from patient document
    useEffect(() => {
        if (!firestore || !user?.patientId) return;

        const fetchPrimaryUserId = async () => {
            try {
                let patientIdToUse: string | null = user.patientId || null;

                // If no patientId, try to find patient by phone number
                if (!patientIdToUse && user.phoneNumber) {
                    const patientsQuery = query(
                        collection(firestore, 'patients'),
                        where('phone', '==', user.phoneNumber)
                    );
                    const patientsSnapshot = await getDocs(patientsQuery);
                    if (!patientsSnapshot.empty) {
                        const primaryPatient = patientsSnapshot.docs.find(d => d.data().isPrimary) || patientsSnapshot.docs[0];
                        patientIdToUse = primaryPatient.id;
                    }
                }

                // Get primaryUserId from patient document
                if (patientIdToUse) {
                    const patientDoc = await getDoc(doc(firestore, 'patients', patientIdToUse));
                    if (patientDoc.exists()) {
                        const patientData = patientDoc.data() as Patient;
                        const primaryUserIdValue = patientData.primaryUserId || null;
                        setPrimaryUserId(primaryUserIdValue);
                    }
                }
            } catch (error) {
                console.error('[NotificationSettings] ❌ Error fetching primaryUserId:', error);
            }
        };

        fetchPrimaryUserId();
    }, [firestore, user?.patientId, user?.phoneNumber]);

    const { data: userResponse, error: userResponseError } = useSWR(
        isMounted && primaryUserId ? `/api/users/${primaryUserId}/notifications` : null,
        async (url) => {
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) {
                // 404 is expected if the document doesn't exist yet - return default values
                if (res.status === 404) {
                    return {
                        fcmToken: null,
                        notificationsEnabled: false,
                        notificationPermissionGranted: false,
                        fcmTokenUpdatedAt: null,
                    };
                }
                throw new Error(`Failed to fetch user settings: ${res.status}`);
            }
            return res.json();
        },
        { 
            revalidateOnFocus: false,
            shouldRetryOnError: false, // Don't retry on 404
        }
    );

    useEffect(() => {
        if (userResponse) {
            setNotificationsEnabled(userResponse.notificationsEnabled === true);
        }
    }, [userResponse]);

    const handleToggle = async (checked: boolean) => {
        setLoading(true);
        
        try {
            if (checked) {
                const permissionGranted = await requestNotificationPermission();
                if (!permissionGranted) {
                    toast({
                        title: notifTexts.permissionDeniedTitle,
                        description: notifTexts.permissionDeniedDesc,
                        variant: 'destructive',
                    });
                    setLoading(false);
                    return;
                }

                // Get FCM token
                const token = await getFCMToken();
                
                if (token && primaryUserId) {
                    await fetch(`/api/users/${primaryUserId}/notifications`, {
                        method: 'PATCH',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            fcmToken: token,
                            notificationsEnabled: true,
                            notificationPermissionGranted: true,
                            fcmTokenUpdatedAt: new Date().toISOString(),
                        }),
                    });
                    mutate(`/api/users/${primaryUserId}/notifications`);

                    setNotificationsEnabled(true);
                    toast({
                        title: notifTexts.enabledTitle,
                        description: notifTexts.enabledDesc,
                    });
                } else if (!primaryUserId) {
                    toast({
                        title: notifTexts.failedTitle,
                        description: 'Primary user ID not found. Please refresh the page.',
                        variant: 'destructive',
                    });
                } else {
                    // Check if we're on localhost
                    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
                    
                    if (isLocalhost) {
                        toast({
                            title: 'Development Mode',
                            description: 'Push notifications may not work on localhost. Try in production or use HTTPS.',
                            variant: 'default',
                            duration: 8000,
                        });
                        // Still save permission status even if token fails in development
                        if (primaryUserId) {
                            await fetch(`/api/users/${primaryUserId}/notifications`, {
                                method: 'PATCH',
                                headers: {
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({
                                    notificationsEnabled: true,
                                    notificationPermissionGranted: true,
                                }),
                            });
                            mutate(`/api/users/${primaryUserId}/notifications`);
                            setNotificationsEnabled(true);
                        }
                    } else {
                        toast({
                            title: notifTexts.failedTitle,
                            description: notifTexts.failedDesc || 'Failed to generate notification token. Please try again or check browser settings.',
                            variant: 'destructive',
                        });
                    }
                }
            } else {
                // Disable notifications
                if (primaryUserId) {
                    await fetch(`/api/users/${primaryUserId}/notifications`, {
                        method: 'PATCH',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            notificationsEnabled: false,
                        }),
                    });
                    mutate(`/api/users/${primaryUserId}/notifications`);
                }
                
                setNotificationsEnabled(false);
                toast({
                    title: notifTexts.disabledTitle,
                    description: notifTexts.disabledDesc,
                });
            }
        } catch (error) {
            console.error('Error toggling notifications:', error);
            toast({
                title: notifTexts.errorTitle,
                description: notifTexts.errorDesc,
                variant: 'destructive',
            });
        } finally {
            setLoading(false);
        }
    };

    if (!isMounted) {
        return null;
    }

    // Show loading if we're still fetching primaryUserId (and user has a patientId)
    if (!primaryUserId && user?.patientId && firestore) {
        return (
            <div className="flex items-center justify-between p-4 border-b last:border-b-0">
                <div className="flex items-center gap-4 flex-1">
                    <Loader2 className="h-6 w-6 text-muted-foreground animate-spin" />
                    <div className="flex-1">
                        <p className="font-semibold">{t.profile.notificationsTitle}</p>
                        <p className="text-sm text-muted-foreground">Loading notification settings...</p>
                    </div>
                </div>
            </div>
        );
    }

    // If no primaryUserId found and we have a patientId, show error state
    if (!primaryUserId && user?.patientId) {
        return (
            <div className="flex items-center justify-between p-4 border-b last:border-b-0">
                <div className="flex items-center gap-4 flex-1">
                    <BellOff className="h-6 w-6 text-muted-foreground" />
                    <div className="flex-1">
                        <p className="font-semibold">{t.profile.notificationsTitle}</p>
                        <p className="text-sm text-muted-foreground">Unable to load notification settings. Please refresh the page.</p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex items-center justify-between p-4 border-b last:border-b-0">
            <div className="flex items-center gap-4 flex-1">
                {notificationsEnabled ? (
                    <Bell className="h-6 w-6 text-primary" />
                ) : (
                    <BellOff className="h-6 w-6 text-muted-foreground" />
                )}
                <div className="flex-1">
                    <p className="font-semibold">{t.profile.notificationsTitle}</p>
                    <p className="text-sm text-muted-foreground">
                        {notificationsEnabled 
                            ? t.profile.notificationsEnabledDesc
                            : t.profile.notificationsDisabledDesc}
                    </p>
                </div>
            </div>
            <Switch
                checked={notificationsEnabled}
                onCheckedChange={handleToggle}
                disabled={loading || !primaryUserId}
            />
        </div>
    );
}


