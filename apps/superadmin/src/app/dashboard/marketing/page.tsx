'use client';

import { useState, useEffect, useCallback } from 'react';
import { collection, query, where, getDocs, orderBy, limit, doc, getDoc, Timestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, TrendingUp, MousePointerClick, Users, Clock, ChevronLeft, ChevronRight, Calendar, RefreshCw } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface CampaignMetrics {
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

type DatePreset = 'all' | 'today' | '7days' | 'month' | 'custom';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getDateRange(preset: DatePreset, customStart?: Date, customEnd?: Date): { start: Date | null; end: Date | null } {
    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

    switch (preset) {
        case 'all':
            return { start: null, end: null };
        case 'today':
            return { start: todayMidnight, end: now };
        case '7days':
            return { start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), end: now };
        case 'month': {
            const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
            return { start: monthStart, end: now };
        }
        case 'custom':
            return { start: customStart || null, end: customEnd || null };
        default:
            return { start: null, end: null };
    }
}

function normalizePhone(p: string) {
    let clean = p.trim().replace(/\D/g, '');
    if (clean.length === 10) clean = '91' + clean;
    return '+' + clean;
}

function toTimestamp(d: Date | null) {
    return d ? Timestamp.fromDate(d) : null;
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------
export default function MarketingDashboard() {
    const [campaigns, setCampaigns] = useState<CampaignMetrics[]>([]);
    const [recentActivity, setRecentActivity] = useState<any[]>([]);
    const [searchPhone, setSearchPhone] = useState('');
    const [loading, setLoading] = useState(true);
    const [searchResults, setSearchResults] = useState<SessionData[]>([]);
    const [windowStatus, setWindowStatus] = useState<{ open: boolean; lastMsg: any } | null>(null);
    const [windowStatuses, setWindowStatuses] = useState<Record<string, boolean>>({});
    const [currentPage, setCurrentPage] = useState(1);
    const itemsPerPage = 15;

    // Date range state
    const [preset, setPreset] = useState<DatePreset>('all');
    const [customStart, setCustomStart] = useState('');
    const [customEnd, setCustomEnd] = useState('');

    const loadData = useCallback(async () => {
        setLoading(true);
        setCampaigns([]);
        setRecentActivity([]);
        setCurrentPage(1);

        const { start, end } = getDateRange(
            preset,
            customStart ? new Date(customStart) : undefined,
            customEnd ? new Date(customEnd + 'T23:59:59') : undefined
        );
        const startTs = toTimestamp(start);
        const endTs = toTimestamp(end);

        try {
            // ------------------------------------------------------------------
            // 1. Fetch campaign_sends with optional date filter
            // ------------------------------------------------------------------
            let sendsQuery = collection(db, 'campaign_sends');
            let sendsQ: any;
            if (startTs && endTs) {
                sendsQ = query(sendsQuery, where('sentAt', '>=', startTs), where('sentAt', '<=', endTs), orderBy('sentAt', 'desc'));
            } else if (startTs) {
                sendsQ = query(sendsQuery, where('sentAt', '>=', startTs), orderBy('sentAt', 'desc'));
            } else {
                sendsQ = query(sendsQuery, orderBy('sentAt', 'desc'));
            }
            const sendsSnap = await getDocs(sendsQ);
            const sends = sendsSnap.docs.map(d => ({ id: d.id, type: 'send', ...d.data() }));

            // ------------------------------------------------------------------
            // 2. Fetch marketing_analytics with optional date filter
            // ------------------------------------------------------------------
            let analyticsQ: any;
            if (startTs && endTs) {
                analyticsQ = query(collection(db, 'marketing_analytics'), where('sessionStart', '>=', start!.toISOString()), where('sessionStart', '<=', end!.toISOString()), orderBy('sessionStart', 'desc'));
            } else if (startTs) {
                analyticsQ = query(collection(db, 'marketing_analytics'), where('sessionStart', '>=', start!.toISOString()), orderBy('sessionStart', 'desc'));
            } else {
                analyticsQ = query(collection(db, 'marketing_analytics'), orderBy('sessionStart', 'desc'));
            }
            const analyticsSnap = await getDocs(analyticsQ);
            const sessions = analyticsSnap.docs.map(d => ({ id: d.id, type: 'click', ...d.data() }));

            // ------------------------------------------------------------------
            // 3. Fetch button interactions with optional date filter
            // ------------------------------------------------------------------
            let interactionsQ: any;
            if (startTs && endTs) {
                interactionsQ = query(collection(db, 'marketing_interactions'), where('timestamp', '>=', startTs), where('timestamp', '<=', endTs), orderBy('timestamp', 'desc'));
            } else if (startTs) {
                interactionsQ = query(collection(db, 'marketing_interactions'), where('timestamp', '>=', startTs), orderBy('timestamp', 'desc'));
            } else {
                interactionsQ = query(collection(db, 'marketing_interactions'), orderBy('timestamp', 'desc'));
            }
            const interactionsSnap = await getDocs(interactionsQ);
            const interactions = interactionsSnap.docs.map(d => ({ id: d.id, type: 'button', ...d.data() }));

            // ------------------------------------------------------------------
            // 4. Compute per-campaign metrics
            // ------------------------------------------------------------------
            const allRefs = new Set<string>();
            sends.forEach((s: any) => s.ref && allRefs.add(s.ref));

            const sessionsByRef = new Map<string, any[]>();
            sessions.forEach((s: any) => {
                if (!s.ref) return;
                if (!sessionsByRef.has(s.ref)) sessionsByRef.set(s.ref, []);
                sessionsByRef.get(s.ref)!.push(s);
            });

            const computed: CampaignMetrics[] = [];
            for (const ref of allRefs) {
                const sendsForRef = sends.filter((s: any) => s.ref === ref);
                const totalSent = sendsForRef.length;

                const refSessions = (sessionsByRef.get(ref) || []).filter((s: any) => !s.isBot);
                const totalClicks = refSessions.length;

                const validSessions = refSessions.filter((s: any) => s.sessionDuration > 5);
                const totalSessions = validSessions.length;

                const sessionsWithActions = refSessions.filter((s: any) => s.actions && s.actions.length > 0);
                const totalActions = sessionsWithActions.length;

                const ctr = totalSent > 0 ? (totalClicks / totalSent) * 100 : 0;
                const conversionRate = totalClicks > 0 ? (totalActions / totalClicks) * 100 : 0;
                const avgSessionDuration = validSessions.length > 0
                    ? validSessions.reduce((sum: number, s: any) => sum + s.sessionDuration, 0) / validSessions.length
                    : 0;
                const avgPagesPerSession = validSessions.length > 0
                    ? validSessions.reduce((sum: number, s: any) => sum + (s.pageCount || 0), 0) / validSessions.length
                    : 0;
                const bouncedSessions = refSessions.filter((s: any) => s.sessionDuration < 10).length;
                const bounceRate = refSessions.length > 0 ? (bouncedSessions / refSessions.length) * 100 : 0;

                const sourceDoc = sendsForRef[0] as any;
                computed.push({
                    ref,
                    campaign: sourceDoc?.campaign || ref,
                    medium: sourceDoc?.medium || 'whatsapp',
                    totalLinksSent: totalSent,
                    totalClicks,
                    totalSessions,
                    totalActions,
                    ctr,
                    conversionRate,
                    avgSessionDuration,
                    avgPagesPerSession,
                    bounceRate,
                });
            }
            computed.sort((a, b) => b.totalClicks - a.totalClicks);
            setCampaigns(computed);

            // ------------------------------------------------------------------
            // 5. Combined activity feed (limited to last 150 across all types)
            // ------------------------------------------------------------------
            const combined = [...sends, ...sessions, ...interactions].sort((a: any, b: any) => {
                const timeA = a.sentAt || a.sessionStart || a.timestamp;
                const timeB = b.sentAt || b.sessionStart || b.timestamp;
                const dateA = typeof timeA === 'string' ? new Date(timeA) : timeA?.toDate?.();
                const dateB = typeof timeB === 'string' ? new Date(timeB) : timeB?.toDate?.();
                return (dateB?.getTime() || 0) - (dateA?.getTime() || 0);
            }).slice(0, 150);
            setRecentActivity(combined);

            // ------------------------------------------------------------------
            // 6. Window statuses
            // ------------------------------------------------------------------
            const uniquePhones = Array.from(new Set(combined.map((a: any) => a.phone).filter(Boolean)));
            if (uniquePhones.length > 0) {
                const statuses: Record<string, boolean> = {};
                for (let i = 0; i < uniquePhones.length; i += 30) {
                    const chunk = uniquePhones.slice(i, i + 30);
                    const bothFormats = [
                        ...chunk.map(p => normalizePhone(p as string)),
                        ...chunk.map(p => normalizePhone(p as string).replace(/^\+/, ''))
                    ];
                    const wq = query(collection(db, 'whatsapp_sessions'), where('phoneNumber', 'in', bothFormats));
                    const wSnap = await getDocs(wq);
                    wSnap.forEach(d => {
                        const data = d.data();
                        if (data.lastMessageAt) {
                            const lastMsg = data.lastMessageAt.toDate();
                            const hours = (new Date().getTime() - lastMsg.getTime()) / (1000 * 60 * 60);
                            const isOpen = hours < 24;
                            statuses[data.phoneNumber] = isOpen;
                            const alt = data.phoneNumber.startsWith('+') ? data.phoneNumber.replace(/^\+/, '') : '+' + data.phoneNumber;
                            statuses[alt] = isOpen;
                        }
                    });
                }
                setWindowStatuses(statuses);
            }
        } catch (error) {
            console.error('[Marketing] Error loading data:', error);
        } finally {
            setLoading(false);
        }
    }, [preset, customStart, customEnd]);

    useEffect(() => {
        if (preset !== 'custom') {
            loadData();
        }
    }, [preset, loadData]);

    // ------------------------------------------------------------------
    // Patient journey search
    // ------------------------------------------------------------------
    async function searchByPhone() {
        if (!searchPhone.trim()) return;
        setLoading(true);
        const normalized = normalizePhone(searchPhone);
        const legacy = normalized.replace(/^\+/, '');
        try {
            let q = query(collection(db, 'marketing_analytics'), where('phone', '==', normalized), orderBy('sessionStart', 'desc'), limit(20));
            let snapshot = await getDocs(q);
            if (snapshot.empty) {
                q = query(collection(db, 'marketing_analytics'), where('phone', '==', legacy), orderBy('sessionStart', 'desc'), limit(20));
                snapshot = await getDocs(q);
            }
            setSearchResults(snapshot.docs.map(d => d.data() as SessionData));

            let sessionRef = doc(db, 'whatsapp_sessions', normalized);
            let sessionSnap = await getDoc(sessionRef);
            if (!sessionSnap.exists()) {
                sessionRef = doc(db, 'whatsapp_sessions', legacy);
                sessionSnap = await getDoc(sessionRef);
            }
            if (sessionSnap.exists()) {
                const sd = sessionSnap.data();
                if (sd.lastMessageAt) {
                    const lastMsg = sd.lastMessageAt.toDate();
                    const diffHours = (new Date().getTime() - lastMsg.getTime()) / (1000 * 60 * 60);
                    setWindowStatus({ open: diffHours < 24, lastMsg: sd.lastMessageAt });
                }
            } else {
                setWindowStatus(null);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    }

    // ------------------------------------------------------------------
    // Derived totals
    // ------------------------------------------------------------------
    const totalClicks = campaigns.reduce((s, c) => s + c.totalClicks, 0);
    const totalSent = campaigns.reduce((s, c) => s + c.totalLinksSent, 0);
    const totalActions = campaigns.reduce((s, c) => s + c.totalActions, 0);
    const overallCTR = totalSent > 0 ? ((totalClicks / totalSent) * 100).toFixed(1) : '0';
    const overallConversion = totalClicks > 0 ? ((totalActions / totalClicks) * 100).toFixed(1) : '0';
    const avgDuration = campaigns.length > 0
        ? (campaigns.reduce((s, c) => s + c.avgSessionDuration, 0) / campaigns.length).toFixed(0)
        : '0';

    const totalPages = Math.ceil(recentActivity.length / itemsPerPage);
    const paginatedActivity = recentActivity.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

    // ------------------------------------------------------------------
    // Preset labels
    // ------------------------------------------------------------------
    const presets: { key: DatePreset; label: string }[] = [
        { key: 'all', label: 'All Time' },
        { key: 'today', label: 'Today' },
        { key: '7days', label: 'Last 7 Days' },
        { key: 'month', label: 'This Month' },
        { key: 'custom', label: 'Custom' },
    ];

    return (
        <div className="p-6 space-y-6">
            <div>
                <h1 className="text-3xl font-bold">Marketing Analytics</h1>
                <p className="text-muted-foreground">Track WhatsApp campaign performance and patient engagement</p>
            </div>

            {/* Date Range Selector */}
            <Card>
                <CardContent className="pt-4 pb-4">
                    <div className="flex flex-wrap items-center gap-3">
                        <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
                        <div className="flex flex-wrap gap-2">
                            {presets.map(p => (
                                <Button
                                    key={p.key}
                                    variant={preset === p.key ? 'default' : 'outline'}
                                    size="sm"
                                    onClick={() => setPreset(p.key)}
                                >
                                    {p.label}
                                </Button>
                            ))}
                        </div>

                        {preset === 'custom' && (
                            <div className="flex items-center gap-2 ml-2">
                                <Input
                                    type="date"
                                    className="w-36 h-8 text-sm"
                                    value={customStart}
                                    onChange={e => setCustomStart(e.target.value)}
                                />
                                <span className="text-muted-foreground text-sm">to</span>
                                <Input
                                    type="date"
                                    className="w-36 h-8 text-sm"
                                    value={customEnd}
                                    onChange={e => setCustomEnd(e.target.value)}
                                />
                                <Button size="sm" onClick={loadData} disabled={!customStart || !customEnd}>
                                    Apply
                                </Button>
                            </div>
                        )}

                        <Button variant="ghost" size="sm" className="ml-auto" onClick={loadData} disabled={loading}>
                            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
                            Refresh
                        </Button>
                    </div>
                </CardContent>
            </Card>

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
                            No campaign data for this date range.
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
                                    <TableRow key={campaign.ref}>
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
                    <CardTitle>Recent Messages &amp; Activity</CardTitle>
                    <CardDescription>Live feed of sent messages, link clicks, and button replies</CardDescription>
                </CardHeader>
                <CardContent>
                    {loading ? (
                        <div className="text-center py-8 text-muted-foreground">Loading activity...</div>
                    ) : recentActivity.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground">No recent activity found.</div>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Time</TableHead>
                                    <TableHead>Patient</TableHead>
                                    <TableHead>Type</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead>Activity</TableHead>
                                    <TableHead>Campaign</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {paginatedActivity.map((act: any) => {
                                    const time = act.sentAt || act.sessionStart || act.timestamp;
                                    const date = typeof time === 'string' ? new Date(time) : time?.toDate?.();
                                    const normalized = act.phone ? normalizePhone(act.phone) : null;
                                    const isWindowOpen = normalized ? windowStatuses[normalized] : false;

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
                                                <div className="flex flex-col gap-1">
                                                    {act.type === 'send' && (
                                                        <span className="inline-flex items-center rounded-full px-2 py-1 text-[10px] font-medium bg-gray-100 text-gray-700 w-fit">Sent</span>
                                                    )}
                                                    {act.type === 'click' && (
                                                        <span className="inline-flex items-center rounded-full px-2 py-1 text-[10px] font-medium bg-blue-100 text-blue-700 w-fit">Clicked Link</span>
                                                    )}
                                                    {act.type === 'button' && (
                                                        <span className="inline-flex items-center rounded-full px-2 py-1 text-[10px] font-medium bg-green-100 text-green-700 w-fit">Replied</span>
                                                    )}
                                                    {isWindowOpen && (
                                                        <span className="inline-flex items-center rounded-full px-2 py-1 text-[10px] font-bold bg-emerald-500 text-white w-fit animate-pulse">24h OPEN</span>
                                                    )}
                                                </div>
                                            </TableCell>
                                            <TableCell className="max-w-[200px] truncate">
                                                {act.type === 'send' && 'WhatsApp Message Out'}
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

                    {!loading && recentActivity.length > itemsPerPage && (
                        <div className="flex items-center justify-between mt-4 border-t pt-4">
                            <div className="text-sm text-muted-foreground">
                                Showing {((currentPage - 1) * itemsPerPage) + 1}–{Math.min(currentPage * itemsPerPage, recentActivity.length)} of {recentActivity.length} events
                            </div>
                            <div className="flex gap-2">
                                <Button variant="outline" size="sm" onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}>
                                    <ChevronLeft className="h-4 w-4 mr-1" /> Previous
                                </Button>
                                <Button variant="outline" size="sm" onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}>
                                    Next <ChevronRight className="h-4 w-4 ml-1" />
                                </Button>
                            </div>
                        </div>
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
                            onChange={e => setSearchPhone(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && searchByPhone()}
                        />
                        <Button onClick={searchByPhone}>
                            <Search className="h-4 w-4 mr-2" /> Search
                        </Button>
                    </div>

                    {searchResults.length > 0 && (
                        <div className="space-y-4">
                            <div className="flex items-center justify-between">
                                <h3 className="font-semibold">Found {searchResults.length} sessions</h3>
                                {windowStatus && (
                                    <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold ${windowStatus.open ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                                        <Clock className="h-3 w-3" />
                                        24h Window: {windowStatus.open ? 'OPEN' : 'CLOSED'}
                                        <span className="text-[10px] opacity-70 ml-1">
                                            (Last msg: {windowStatus.lastMsg.toDate().toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })})
                                        </span>
                                    </div>
                                )}
                            </div>
                            {searchResults.map((session, idx) => (
                                <Card key={idx}>
                                    <CardContent className="pt-6">
                                        <div className="grid grid-cols-2 gap-4 text-sm">
                                            <div><p className="text-muted-foreground">Campaign</p><p className="font-medium">{session.campaign}</p></div>
                                            <div><p className="text-muted-foreground">Duration</p><p className="font-medium">{session.sessionDuration}s</p></div>
                                            <div><p className="text-muted-foreground">Pages Visited</p><p className="font-medium">{session.pageCount} pages</p></div>
                                            <div><p className="text-muted-foreground">Device</p><p className="font-medium capitalize">{session.deviceType}</p></div>
                                            <div className="col-span-2"><p className="text-muted-foreground">Page Flow</p><p className="font-medium text-xs">{session.pageFlow || 'N/A'}</p></div>
                                            {session.actions.length > 0 && (
                                                <div className="col-span-2">
                                                    <p className="text-muted-foreground">Actions</p>
                                                    <div className="flex flex-wrap gap-1 mt-1">
                                                        {session.actions.map((action, i) => (
                                                            <span key={i} className="inline-flex items-center rounded-full px-2 py-1 text-xs font-medium bg-green-50 text-green-700">{action}</span>
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

                    {!loading && searchResults.length === 0 && searchPhone && (
                        <div className="text-center py-8 text-muted-foreground bg-gray-50 rounded-lg border border-dashed">
                            No journey data found for "{normalizePhone(searchPhone)}".
                            <br /><span className="text-xs opacity-60">(Try a phone number that has clicked a marketing link)</span>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
