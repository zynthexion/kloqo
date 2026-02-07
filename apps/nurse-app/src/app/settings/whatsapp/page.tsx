'use client';

import React, { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { CodeService } from '@kloqo/shared-core';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, MessageSquare, RefreshCw, Copy, Check } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export default function WhatsAppSettingsPage() {
    const { user, loading: authLoading } = useAuth();
    const { toast } = useToast();
    const [shortCode, setShortCode] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!user?.clinicId) return;

        setLoading(true);
        const clinicRef = doc(db, 'clinics', user.clinicId);

        // Listen for real-time updates
        const unsubscribe = onSnapshot(clinicRef, (doc) => {
            if (doc.exists()) {
                const data = doc.data();
                setShortCode(data.shortCode || null);
            }
            setLoading(false);
        }, (error) => {
            console.error("Error fetching clinic:", error);
            setLoading(false);
        });

        return () => unsubscribe();
    }, [user?.clinicId]);

    const handleGenerateCode = async () => {
        if (!user?.clinicId) return;

        setGenerating(true);
        try {
            const code = await CodeService.ensureClinicCode(user.clinicId);
            setShortCode(code);
            toast({
                title: "Code Generated",
                description: "Clinic short code generated successfully!",
            });
        } catch (error) {
            console.error('Error generating code:', error);
            toast({
                variant: "destructive",
                title: "Generation Failed",
                description: "Failed to generate short code. Please try again.",
            });
        } finally {
            setGenerating(false);
        }
    };

    const handleCopyCode = () => {
        if (shortCode) {
            navigator.clipboard.writeText(shortCode);
            setCopied(true);
            toast({
                title: "Copied",
                description: "Short code copied to clipboard",
            });
            setTimeout(() => setCopied(false), 2000);
        }
    };

    if (authLoading || loading) {
        return (
            <div className="flex items-center justify-center h-full min-h-[400px]">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        );
    }

    return (
        <div className="space-y-6 max-w-3xl">
            <div>
                <h2 className="text-2xl font-bold tracking-tight">WhatsApp Integration</h2>
                <p className="text-muted-foreground">
                    Manage your clinic's WhatsApp chatbot settings and short code.
                </p>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <MessageSquare className="h-5 w-5" />
                        Clinic Short Code
                    </CardTitle>
                    <CardDescription>
                        This unique code allows patients to interact with your clinic via our WhatsApp chatbot.
                        Patients simply send this code to our WhatsApp number to get started.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    {shortCode ? (
                        <div className="flex flex-col gap-4">
                            <div className="p-6 bg-secondary/20 rounded-lg border border-border flex flex-col items-center justify-center text-center gap-2">
                                <span className="text-sm text-muted-foreground uppercase tracking-wider font-medium">Your Unique Code</span>
                                <div className="text-4xl font-black tracking-widest text-primary font-mono select-all">
                                    {shortCode}
                                </div>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="mt-2 text-muted-foreground hover:text-foreground"
                                    onClick={handleCopyCode}
                                >
                                    {copied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
                                    {copied ? 'Copied' : 'Copy Code'}
                                </Button>
                            </div>

                            <div className="bg-blue-50 dark:bg-blue-950/30 p-4 rounded-md text-sm text-blue-800 dark:text-blue-200 border border-blue-100 dark:border-blue-900">
                                <p className="font-semibold mb-1">How it works:</p>
                                <ol className="list-decimal ml-4 space-y-1">
                                    <li>Share this code with your patients.</li>
                                    <li>Ask them to send <strong>{shortCode}</strong> to our WhatsApp number.</li>
                                    <li>The chatbot will instantly provide your clinic's details and booking options.</li>
                                </ol>
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-8 text-center space-y-4">
                            <div className="bg-yellow-50 dark:bg-yellow-950/30 p-4 rounded-full">
                                <RefreshCw className="h-8 w-8 text-yellow-600 dark:text-yellow-400" />
                            </div>
                            <div className="space-y-1">
                                <h3 className="font-semibold">No Short Code Assigned</h3>
                                <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                                    Your clinic doesn't have a short code yet. Generate one now to enable WhatsApp features.
                                </p>
                            </div>
                            <Button
                                onClick={handleGenerateCode}
                                disabled={generating}
                                className="min-w-[200px]"
                            >
                                {generating ? (
                                    <>
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        Generating...
                                    </>
                                ) : (
                                    <>
                                        Generate Short Code
                                    </>
                                )}
                            </Button>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
