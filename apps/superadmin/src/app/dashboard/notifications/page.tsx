'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import {
    Bell,
    Search,
    RefreshCw,
    CheckCircle,
    XCircle,
    MessageSquare,
    Calendar,
    UserPlus,
    Clock,
    AlertTriangle,
    Info
} from 'lucide-react';
import { doc, setDoc, getDoc, collection, getDocs, writeBatch, serverTimestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import {
    NOTIFICATION_TYPES,
    NOTIFICATION_METADATA,
    NotificationType,
    NotificationConfig,
    clearNotificationCache
} from '@kloqo/shared-core';
import { useAuth } from '@/contexts/AuthContext';

// Category icons mapping
const CATEGORY_ICONS: Record<string, any> = {
    booking: UserPlus,
    status: Info,
    queue: MessageSquare,
    reminder: Calendar,
    'follow-up': Clock,
};

export default function NotificationsPage() {
    const { user } = useAuth();
    const [loading, setLoading] = useState(true);
    const [resetting, setResetting] = useState(false);
    const [configs, setConfigs] = useState<Record<string, NotificationConfig>>({});
    const [searchTerm, setSearchTerm] = useState('');

    const loadConfigs = async () => {
        setLoading(true);
        try {
            const newConfigs: Record<string, NotificationConfig> = {};

            // Fetch all from Firestore - RENAMED to 'templates'
            const querySnapshot = await getDocs(collection(db, 'system-config', 'notifications', 'templates'));
            querySnapshot.forEach((doc) => {
                const data = doc.data();
                newConfigs[doc.id] = {
                    ...data,
                    // Migration: fallback to old 'enabled' field if 'whatsappEnabled' is missing
                    whatsappEnabled: data.whatsappEnabled ?? data.enabled ?? true,
                    pwaEnabled: data.pwaEnabled ?? true,
                } as NotificationConfig;
            });

            // Fill in missing ones or sync metadata
            Object.entries(NOTIFICATION_TYPES).forEach(([key, id]) => {
                const notificationId = id as string;
                const meta = NOTIFICATION_METADATA[notificationId as NotificationType];

                if (!newConfigs[notificationId]) {
                    newConfigs[notificationId] = {
                        id,
                        name: meta.name,
                        description: meta.description,
                        category: meta.category,
                        channels: meta.channels,
                        whatsappEnabled: true,
                        pwaEnabled: true,
                        updatedAt: null,
                    };
                } else {
                    // Always use latest metadata from shared-core
                    newConfigs[notificationId].name = meta.name;
                    newConfigs[notificationId].description = meta.description;
                    newConfigs[notificationId].category = meta.category;
                    newConfigs[notificationId].channels = meta.channels;
                }
            });

            setConfigs(newConfigs);
        } catch (error) {
            console.error('Error loading notification configs:', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadConfigs();
    }, []);

    const handleToggle = async (id: string, channel: 'whatsapp' | 'pwa', currentState: boolean) => {
        try {
            const newState = !currentState;
            const field = channel === 'whatsapp' ? 'whatsappEnabled' : 'pwaEnabled';

            // Optimistic update
            setConfigs(prev => ({
                ...prev,
                [id]: { ...prev[id], [field]: newState }
            }));

            const configRef = doc(db, 'system-config', 'notifications', 'templates', id);
            await setDoc(configRef, {
                ...configs[id],
                [field]: newState,
                updatedAt: serverTimestamp(),
                updatedBy: user?.email || 'unknown'
            }, { merge: true });

            clearNotificationCache();
            console.log(`[Notifications] Toggle ${id} ${channel} to ${newState}`);
        } catch (error) {
            console.error(`Error toggling notification ${id}:`, error);
            loadConfigs();
        }
    };

    const handleResetToDefaults = async () => {
        if (!confirm('Are you sure you want to reset all notifications (WhatsApp & PWA) to enabled? This will overwrite individual settings.')) return;

        setResetting(true);
        try {
            const batch = writeBatch(db);

            Object.entries(NOTIFICATION_TYPES).forEach(([key, id]) => {
                const notificationId = id as string;
                const meta = NOTIFICATION_METADATA[notificationId as NotificationType];
                const configRef = doc(db, 'system-config', 'notifications', 'templates', notificationId);
                batch.set(configRef, {
                    id,
                    name: meta.name,
                    description: meta.description,
                    category: meta.category,
                    channels: meta.channels,
                    whatsappEnabled: true,
                    pwaEnabled: true,
                    updatedAt: serverTimestamp(),
                    updatedBy: user?.email || 'system'
                });
            });

            await batch.commit();
            clearNotificationCache();
            await loadConfigs();
        } catch (error) {
            console.error('Error resetting configs:', error);
        } finally {
            setResetting(false);
        }
    };

    const filteredNotificationIds = Object.keys(configs).filter(id => {
        const config = configs[id];
        return config.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            config.description.toLowerCase().includes(searchTerm.toLowerCase());
    });

    const categories = Array.from(new Set(Object.values(configs).map(c => c.category)));

    if (loading && Object.keys(configs).length === 0) {
        return (
            <div className="flex h-64 items-center justify-center">
                <div className="text-center">
                    <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto mb-4" />
                    <p className="text-muted-foreground">Loading configurations...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold flex items-center gap-2">
                        <Bell className="h-8 w-8 text-primary" />
                        Notification Channels
                    </h1>
                    <p className="text-muted-foreground mt-1">
                        Global toggles for WhatsApp and PWA / Push notifications.
                    </p>
                </div>
                <Button
                    variant="outline"
                    onClick={handleResetToDefaults}
                    disabled={resetting}
                    className="flex items-center gap-2"
                >
                    <RefreshCw className={`h-4 w-4 ${resetting ? 'animate-spin' : ''}`} />
                    Reset All to Defaults
                </Button>
            </div>

            <Card>
                <CardHeader className="pb-3">
                    <div className="relative">
                        <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                        <Input
                            placeholder="Search notification templates..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="pl-10 h-10"
                        />
                    </div>
                </CardHeader>
            </Card>

            {categories.map(category => {
                const categoryConfigs = filteredNotificationIds
                    .map(id => configs[id])
                    .filter(c => c.category === category);

                if (categoryConfigs.length === 0) return null;

                const CategoryIcon = CATEGORY_ICONS[category] || Bell;

                return (
                    <div key={category} className="space-y-4">
                        <h2 className="text-lg font-semibold flex items-center gap-2 capitalize">
                            <CategoryIcon className="h-5 w-5 text-gray-500" />
                            {category} Notifications
                        </h2>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {categoryConfigs.map(config => {
                                const isSomeDisabled = (config.channels.includes('whatsapp') && !config.whatsappEnabled) ||
                                    (config.channels.includes('pwa') && !config.pwaEnabled);

                                return (
                                    <Card key={config.id} className={`transition-all ${isSomeDisabled ? 'bg-gray-50/50' : 'border-l-4 border-l-primary'}`}>
                                        <CardHeader className="pb-2">
                                            <CardTitle className="text-base">{config.name}</CardTitle>
                                            <CardDescription className="text-xs mt-1 line-clamp-2 min-h-[32px]">
                                                {config.description}
                                            </CardDescription>
                                        </CardHeader>
                                        <CardContent className="space-y-3">
                                            <div className="flex flex-col gap-2">
                                                {config.channels.includes('whatsapp') && (
                                                    <div className={`flex items-center justify-between p-2 rounded border ${config.whatsappEnabled ? 'bg-green-50/30 border-green-100' : 'bg-gray-100/50 border-gray-200 opacity-60'}`}>
                                                        <div className="flex items-center gap-2">
                                                            <MessageSquare className={`h-4 w-4 ${config.whatsappEnabled ? 'text-green-600' : 'text-gray-400'}`} />
                                                            <span className="text-xs font-medium">WhatsApp</span>
                                                        </div>
                                                        <Switch
                                                            checked={config.whatsappEnabled}
                                                            onCheckedChange={() => handleToggle(config.id, 'whatsapp', config.whatsappEnabled)}
                                                        />
                                                    </div>
                                                )}
                                                {config.channels.includes('pwa') && (
                                                    <div className={`flex items-center justify-between p-2 rounded border ${config.pwaEnabled ? 'bg-blue-50/30 border-blue-100' : 'bg-gray-100/50 border-gray-200 opacity-60'}`}>
                                                        <div className="flex items-center gap-2">
                                                            <Bell className={`h-4 w-4 ${config.pwaEnabled ? 'text-blue-600' : 'text-gray-400'}`} />
                                                            <span className="text-xs font-medium">PWA / Push</span>
                                                        </div>
                                                        <Switch
                                                            checked={config.pwaEnabled}
                                                            onCheckedChange={() => handleToggle(config.id, 'pwa', config.pwaEnabled)}
                                                        />
                                                    </div>
                                                )}
                                            </div>

                                            <div className="flex items-center justify-between pt-1">
                                                <div className="flex gap-1">
                                                    {config.channels.includes('whatsapp') && (
                                                        <Badge variant={config.whatsappEnabled ? 'outline' : 'secondary'} className={`text-[9px] px-1 ${config.whatsappEnabled ? 'border-green-200 text-green-700' : ''}`}>
                                                            WA
                                                        </Badge>
                                                    )}
                                                    {config.channels.includes('pwa') && (
                                                        <Badge variant={config.pwaEnabled ? 'outline' : 'secondary'} className={`text-[9px] px-1 ${config.pwaEnabled ? 'border-blue-200 text-blue-700' : ''}`}>
                                                            PWA
                                                        </Badge>
                                                    )}
                                                </div>
                                                {config.updatedAt && (
                                                    <span className="text-[9px] text-muted-foreground italic">
                                                        Updated {new Date(config.updatedAt?.seconds * 1000).toLocaleDateString()}
                                                    </span>
                                                )}
                                            </div>
                                        </CardContent>
                                    </Card>
                                );
                            })}
                        </div>
                    </div>
                );
            })}

            {filteredNotificationIds.length === 0 && (
                <div className="text-center py-12">
                    <AlertTriangle className="h-12 w-12 text-yellow-500 mx-auto mb-4 opacity-50" />
                    <h3 className="text-lg font-medium">No results found</h3>
                    <p className="text-muted-foreground">Try adjusting your search terms.</p>
                </div>
            )}
        </div>
    );
}
