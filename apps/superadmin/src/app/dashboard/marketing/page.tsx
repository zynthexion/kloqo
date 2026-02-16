'use client';

import { useState, useEffect } from 'react';
import { collection, query, where, getDocs, orderBy, limit } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, TrendingUp, MousePointerClick, Users, Clock } from 'lucide-react';

interface CampaignSummary {
    id: string;
    ref: string;
    campaign: string;
    medium: string;
    totalLinksSent: number;
    totalClicks: number;
    totalSessions: number;
    totalActions: number;
    ctr: number;
    conversionRate: number;
    avgSessionDuration: number;
    avgPagesPerSession: number;
    bounceRate: number;
}

interface SessionData {
    sessionId: string;
    phone?: string;
    patientId?: string;
    ref: string;
    campaign: string;
    sessionDuration: number;
    pageFlow: string;
    pageCount: number;
    actions: string[];
    deviceType: string;
    sessionStart: string;
}

export default function MarketingDashboard() {
    const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
    const [sessions, setSessions] = useState<SessionData[]>([]);
    const [searchPhone, setSearchPhone] = useState('');
    const [loading, setLoading] = useState(true);
    const [searchResults, setSearchResults] = useState<SessionData[]>([]);
    const [recentActivity, setRecentActivity] = useState<any[]>([]);

    // Load campaign summaries
    useEffect(() => {
        loadCampaignSummaries();
        loadRecentActivity();
    }, []);

    async function loadCampaignSummaries() {
        try {
            const q = query(collection(db, 'campaign_summaries'), orderBy('totalClicks', 'desc'));
            const snapshot = await getDocs(q);
            const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as CampaignSummary));
            setCampaigns(data);
        } catch (error) {
            console.error('Error loading campaigns:', error);
        }
    }

    async function loadRecentActivity() {
        try {
            // 1. Get last 50 sends
            const sendsQ = query(
                collection(db, 'campaign_sends'),
                orderBy('sentAt', 'desc'),
                limit(50)
            );
            const sendsSnap = await getDocs(sendsQ);
            const sends = sendsSnap.docs.map(doc => ({ id: doc.id, type: 'send', ...doc.data() }));

            // 2. Get last 50 clicks/sessions
            const clicksQ = query(
                collection(db, 'marketing_analytics'),
                orderBy('sessionStart', 'desc'),
                limit(50)
            );
            const clicksSnap = await getDocs(clicksQ);
            const clicks = clicksSnap.docs.map(doc => ({ id: doc.id, type: 'click', ...doc.data() }));

            // 3. Get last 50 button interactions
            const interactionsQ = query(
                collection(db, 'marketing_interactions'),
                orderBy('timestamp', 'desc'),
                limit(50)
            );
            const interactionsSnap = await getDocs(interactionsQ);
            const interactions = interactionsSnap.docs.map(doc => ({ id: doc.id, type: 'button', ...doc.data() }));

            // Join them into a unified activity feed
            const combined = [...sends, ...clicks, ...interactions].sort((a: any, b: any) => {
                const timeA = a.sentAt || a.sessionStart || a.timestamp;
                const timeB = b.sentAt || b.sessionStart || b.timestamp;
                const dateA = typeof timeA === 'string' ? new Date(timeA) : timeA?.toDate();
                const dateB = typeof timeB === 'string' ? new Date(timeB) : timeB?.toDate();
                return (dateB?.getTime() || 0) - (dateA?.getTime() || 0);
            });

            setRecentActivity(combined);
        } catch (error) {
            console.error('Error loading activity:', error);
        } finally {
            setLoading(false);
        }
    }

    async function searchByPhone() {
        if (!searchPhone.trim()) return;

        try {
            setLoading(true);
            const q = query(
                collection(db, 'marketing_analytics'),
                where('phone', '==', searchPhone.trim()),
                orderBy('sessionStart', 'desc'),
                limit(20)
            );
            const snapshot = await getDocs(q);
            const data = snapshot.docs.map(doc => doc.data() as SessionData);
            setSearchResults(data);
        } catch (error) {
            console.error('Error searching sessions:', error);
        } finally {
            setLoading(false);
        }
    }

    // Calculate overall metrics
    const totalClicks = campaigns.reduce((sum, c) => sum + c.totalClicks, 0);
    const totalSent = campaigns.reduce((sum, c) => sum + c.totalLinksSent, 0);
    const totalSessions = campaigns.reduce((sum, c) => sum + c.totalSessions, 0);
    const totalActions = campaigns.reduce((sum, c) => sum + c.totalActions, 0);
    const overallCTR = totalSent > 0 ? ((totalClicks / totalSent) * 100).toFixed(1) : '0';
    const overallConversion = totalClicks > 0 ? ((totalActions / totalClicks) * 100).toFixed(1) : '0';
    const avgDuration = campaigns.length > 0
        ? (campaigns.reduce((sum, c) => sum + c.avgSessionDuration, 0) / campaigns.length).toFixed(0)
        : '0';

    return (
        <div className="p-6 space-y-6">
            <div>
                <h1 className="text-3xl font-bold">Marketing Analytics</h1>
                <p className="text-muted-foreground">Track WhatsApp campaign performance and patient engagement</p>
            </div>

            {/* Overview Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Total Clicks</CardTitle>
                        <MousePointerClick className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{totalClicks.toLocaleString()}</div>
                        <p className="text-xs text-muted-foreground">From {totalSent.toLocaleString()} sent</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Click-Through Rate</CardTitle>
                        <TrendingUp className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{overallCTR}%</div>
                        <p className="text-xs text-muted-foreground">Target: 20%+</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Conversion Rate</CardTitle>
                        <Users className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{overallConversion}%</div>
                        <p className="text-xs text-muted-foreground">{totalActions} actions taken</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Avg Session</CardTitle>
                        <Clock className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{avgDuration}s</div>
                        <p className="text-xs text-muted-foreground">Target: 180s+ (3 min)</p>
                    </CardContent>
                </Card>
            </div>

            {/* Campaign Performance Table */}
            <Card>
                <CardHeader>
                    <CardTitle>Campaign Performance</CardTitle>
                    <CardDescription>Compare performance across all WhatsApp campaigns</CardDescription>
                </CardHeader>
                <CardContent>
                    {loading ? (
                        <div className="text-center py-8 text-muted-foreground">Loading campaigns...</div>
                    ) : campaigns.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground">
                            No campaign data yet. Start sending tracked WhatsApp messages!
                        </div>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Campaign</TableHead>
                                    <TableHead>Medium</TableHead>
                                    <TableHead className="text-right">Sent</TableHead>
                                    <TableHead className="text-right">Clicks</TableHead>
                                    <TableHead className="text-right">CTR</TableHead>
                                    <TableHead className="text-right">Sessions</TableHead>
                                    <TableHead className="text-right">Actions</TableHead>
                                    <TableHead className="text-right">Conv Rate</TableHead>
                                    <TableHead className="text-right">Avg Duration</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {campaigns.map((campaign) => (
                                    <TableRow key={campaign.id}>
                                        <TableCell className="font-medium">{campaign.campaign}</TableCell>
                                        <TableCell>
                                            <span className="inline-flex items-center rounded-full px-2 py-1 text-xs font-medium bg-blue-50 text-blue-700">
                                                {campaign.medium}
                                            </span>
                                        </TableCell>
                                        <TableCell className="text-right">{campaign.totalLinksSent.toLocaleString()}</TableCell>
                                        <TableCell className="text-right">{campaign.totalClicks.toLocaleString()}</TableCell>
                                        <TableCell className="text-right">
                                            <span className={campaign.ctr >= 20 ? 'text-green-600 font-semibold' : ''}>
                                                {campaign.ctr.toFixed(1)}%
                                            </span>
                                        </TableCell>
                                        <TableCell className="text-right">{campaign.totalSessions.toLocaleString()}</TableCell>
                                        <TableCell className="text-right">{campaign.totalActions.toLocaleString()}</TableCell>
                                        <TableCell className="text-right">
                                            <span className={campaign.conversionRate >= 30 ? 'text-green-600 font-semibold' : ''}>
                                                {campaign.conversionRate.toFixed(1)}%
                                            </span>
                                        </TableCell>
                                        <TableCell className="text-right">{Math.round(campaign.avgSessionDuration)}s</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>

            {/* Recent Activity Feed */}
            <Card>
                <CardHeader>
                    <CardTitle>Recent Messages & Activity</CardTitle>
                    <CardDescription>Live feed of sent messages, link clicks, and button replies</CardDescription>
                </CardHeader>
                <CardContent>
                    {loading ? (
                        <div className="text-center py-8 text-muted-foreground">Loading activity...</div>
                    ) : recentActivity.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground">
                            No recent activity found.
                        </div>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Time</TableHead>
                                    <TableHead>Patient</TableHead>
                                    <TableHead>Type</TableHead>
                                    <TableHead>Activity</TableHead>
                                    <TableHead>Campaign</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {recentActivity.map((act) => {
                                    const time = act.sentAt || act.sessionStart || act.timestamp;
                                    const date = typeof time === 'string' ? new Date(time) : time?.toDate();

                                    return (
                                        <TableRow key={act.id}>
                                            <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                                                {date ? date.toLocaleString('en-IN', {
                                                    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
                                                }) : 'Unknown'}
                                            </TableCell>
                                            <TableCell>
                                                <div className="font-medium">{act.patientName || 'Unknown'}</div>
                                                <div className="text-xs text-muted-foreground">{act.phone}</div>
                                            </TableCell>
                                            <TableCell>
                                                {act.type === 'send' && (
                                                    <span className="inline-flex items-center rounded-full px-2 py-1 text-xs font-medium bg-gray-100 text-gray-700">
                                                        Sent
                                                    </span>
                                                )}
                                                {act.type === 'click' && (
                                                    <span className="inline-flex items-center rounded-full px-2 py-1 text-xs font-medium bg-blue-100 text-blue-700">
                                                        Clicked Link
                                                    </span>
                                                )}
                                                {act.type === 'button' && (
                                                    <span className="inline-flex items-center rounded-full px-2 py-1 text-xs font-medium bg-green-100 text-green-700">
                                                        Replied
                                                    </span>
                                                )}
                                            </TableCell>
                                            <TableCell className="max-w-[200px] truncate">
                                                {act.type === 'send' && "WhatsApp Message Out"}
                                                {act.type === 'click' && `Visited ${act.pageCount} pages (${act.sessionDuration}s)`}
                                                {act.type === 'button' && `Button: "${act.buttonText}"`}
                                            </TableCell>
                                            <TableCell className="text-xs">{act.campaign || act.ref || '--'}</TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>

            {/* Individual Patient Search */}
            <Card>
                <CardHeader>
                    <CardTitle>Patient Journey Tracking</CardTitle>
                    <CardDescription>Search by phone number to see complete engagement history</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex gap-2">
                        <Input
                            placeholder="Enter phone number (e.g., +919074297611)"
                            value={searchPhone}
                            onChange={(e) => setSearchPhone(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && searchByPhone()}
                        />
                        <Button onClick={searchByPhone}>
                            <Search className="h-4 w-4 mr-2" />
                            Search
                        </Button>
                    </div>

                    {searchResults.length > 0 && (
                        <div className="space-y-4">
                            <h3 className="font-semibold">Found {searchResults.length} sessions</h3>
                            {searchResults.map((session, idx) => (
                                <Card key={idx}>
                                    <CardContent className="pt-6">
                                        <div className="grid grid-cols-2 gap-4 text-sm">
                                            <div>
                                                <p className="text-muted-foreground">Campaign</p>
                                                <p className="font-medium">{session.campaign}</p>
                                            </div>
                                            <div>
                                                <p className="text-muted-foreground">Duration</p>
                                                <p className="font-medium">{session.sessionDuration}s</p>
                                            </div>
                                            <div>
                                                <p className="text-muted-foreground">Pages Visited</p>
                                                <p className="font-medium">{session.pageCount} pages</p>
                                            </div>
                                            <div>
                                                <p className="text-muted-foreground">Device</p>
                                                <p className="font-medium capitalize">{session.deviceType}</p>
                                            </div>
                                            <div className="col-span-2">
                                                <p className="text-muted-foreground">Page Flow</p>
                                                <p className="font-medium text-xs">{session.pageFlow || 'N/A'}</p>
                                            </div>
                                            {session.actions.length > 0 && (
                                                <div className="col-span-2">
                                                    <p className="text-muted-foreground">Actions</p>
                                                    <div className="flex flex-wrap gap-1 mt-1">
                                                        {session.actions.map((action, i) => (
                                                            <span key={i} className="inline-flex items-center rounded-full px-2 py-1 text-xs font-medium bg-green-50 text-green-700">
                                                                {action}
                                                            </span>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
