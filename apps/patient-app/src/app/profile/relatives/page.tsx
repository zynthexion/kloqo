'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, User, UserMinus, UserPen, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useFirestore } from '@/firebase';
import type { Patient } from '@/lib/types';
import { useUser } from '@/firebase/auth/use-user';
import { useLanguage } from '@/contexts/language-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { useToast } from '@/hooks/use-toast';
import { AuthGuard } from '@/components/auth-guard';
import { unlinkRelative } from '@kloqo/shared-core';
import { getPatientListFromCache, savePatientListToCache, clearPatientListCache } from '@/lib/patient-cache';
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
import { RelativeDialog } from '@/components/patients/relative-dialog';

function RelativesManagementPage() {
    const { t } = useLanguage();
    const { user, loading: userLoading } = useUser();
    const firestore = useFirestore();
    const router = useRouter();
    const { toast } = useToast();

    const [relatives, setRelatives] = useState<Patient[]>([]);
    const [loading, setLoading] = useState(true);
    const [primaryPatient, setPrimaryPatient] = useState<Patient | null>(null);

    const [patientToDelete, setPatientToDelete] = useState<Patient | null>(null);
    const [patientToEdit, setPatientToEdit] = useState<Patient | null>(null);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
    const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
    const [isUnlinking, setIsUnlinking] = useState(false);

    const fetchRelatives = useCallback(async () => {
        if (!user?.phoneNumber) {
            setLoading(false);
            return;
        }

        // 1. Try cache first for instant display
        const cachedData = getPatientListFromCache(user.phoneNumber);
        if (cachedData) {
            setPrimaryPatient(cachedData.primary as Patient);
            setRelatives(cachedData.relatives as Patient[]);
            if (loading) setLoading(false);
        }

        // 2. Always fetch fresh data in background
        try {
            const response = await fetch(`/api/patients?phone=${encodeURIComponent(user.phoneNumber)}`, {
                cache: 'no-store',
            });

            if (!response.ok) {
                throw new Error('Failed to fetch patients');
            }

            const { primary, relatives: fetchedRelatives }: { primary: (Patient & { id: string }) | null; relatives: (Patient & { id: string })[] } = await response.json();

            // Update cache
            savePatientListToCache(user.phoneNumber, primary, fetchedRelatives);

            setPrimaryPatient(primary as Patient);
            setRelatives(fetchedRelatives as Patient[]);
        } catch (error) {
            console.error('Error fetching relatives:', error);
            if (!cachedData) {
                toast({
                    variant: 'destructive',
                    title: t.common.error,
                    description: t.patientForm.patientCreationFailed,
                });
            }
        } finally {
            setLoading(false);
        }
    }, [user?.phoneNumber, loading, toast]);

    useEffect(() => {
        if (!userLoading && user) {
            fetchRelatives();
        }
    }, [user, userLoading, fetchRelatives]);

    const handleUnlink = async () => {
        if (!patientToDelete || !primaryPatient?.id) return;

        setIsUnlinking(true);
        try {
            await unlinkRelative(primaryPatient.id, patientToDelete.id);

            // Clear cache to force refresh
            if (user?.phoneNumber) {
                clearPatientListCache(user.phoneNumber);
            }

            toast({
                title: t.messages.success,
                description: t.patientForm.confirmUnlinkDesc.replace('{name}', patientToDelete.name),
            });

            // Refresh list
            fetchRelatives();
            setIsDeleteDialogOpen(false);
        } catch (error) {
            console.error('Error unlinking relative:', error);
            toast({
                variant: 'destructive',
                title: t.common.error,
                description: 'Failed to remove relative.',
            });
        } finally {
            setIsUnlinking(false);
            setPatientToDelete(null);
        }
    };

    if (loading && relatives.length === 0) {
        return (
            <div className="flex h-screen items-center justify-center bg-green-50/50">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        );
    }

    return (
        <div className="flex min-h-screen w-full flex-col bg-green-50/50 font-body">
            <header className="flex items-center p-4">
                <Link href="/profile" className="p-2">
                    <ArrowLeft className="h-6 w-6" />
                </Link>
                <h1 className="text-xl font-bold text-center flex-grow">{t.profile.friendsAndFamily}</h1>
                <div className="w-8"></div>
            </header>

            <main className="flex-grow p-4 space-y-4">
                {relatives.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center space-y-4">
                        <div className="bg-white p-6 rounded-full shadow-sm">
                            <User className="h-12 w-12 text-muted-foreground" />
                        </div>
                        <div className="space-y-1">
                            <h3 className="font-bold text-lg">{t.patientForm.noRelatives}</h3>
                            <p className="text-sm text-muted-foreground px-8">
                                {t.patientForm.noRelativesDesc}
                            </p>
                        </div>
                    </div>
                ) : (
                    <div className="grid gap-4">
                        {relatives.map((relative) => (
                            <Card key={relative.id} className="overflow-hidden border-none shadow-sm">
                                <CardContent className="p-4 flex items-center justify-between">
                                    <div className="flex items-center gap-4">
                                        <Avatar className="h-12 w-12 bg-primary/10">
                                            <AvatarFallback className="text-primary font-bold">
                                                {relative.name?.substring(0, 1).toUpperCase()}
                                            </AvatarFallback>
                                        </Avatar>
                                        <div className="space-y-0.5">
                                            <h3 className="font-bold">{relative.name}</h3>
                                            <p className="text-xs text-muted-foreground">
                                                {relative.age} {t.patientForm.years} • {relative.sex === 'Male' ? t.patientForm.male : relative.sex === 'Female' ? t.patientForm.female : t.patientForm.other}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="text-primary hover:text-primary hover:bg-primary/10"
                                            onClick={() => {
                                                setPatientToEdit(relative);
                                                setIsEditDialogOpen(true);
                                            }}
                                        >
                                            <UserPen className="h-5 w-5" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="text-red-500 hover:text-red-600 hover:bg-red-50"
                                            onClick={() => {
                                                setPatientToDelete(relative);
                                                setIsDeleteDialogOpen(true);
                                            }}
                                        >
                                            <UserMinus className="h-5 w-5" />
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                )}
            </main>

            <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{t.patientForm.confirmUnlinkTitle}</AlertDialogTitle>
                        <AlertDialogDescription>
                            {t.patientForm.confirmUnlinkDesc.replace('{name}', patientToDelete?.name || '')}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={isUnlinking}>{t.common.cancel}</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={(e) => {
                                e.preventDefault();
                                handleUnlink();
                            }}
                            className="bg-red-500 hover:bg-red-600 text-white"
                            disabled={isUnlinking}
                        >
                            {isUnlinking ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                            {t.patientForm.deleteHeader}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {patientToEdit && (
                <RelativeDialog
                    isOpen={isEditDialogOpen}
                    setIsOpen={setIsEditDialogOpen}
                    patient={patientToEdit}
                    onSuccess={() => {
                        fetchRelatives();
                        setIsEditDialogOpen(false);
                        setPatientToEdit(null);
                    }}
                    clinicId={null} // Not needed for update
                />
            )}
        </div>
    );
}

export default function RelativesPage() {
    return (
        <AuthGuard>
            <RelativesManagementPage />
        </AuthGuard>
    );
}
