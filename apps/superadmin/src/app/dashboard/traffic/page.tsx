'use client';

import { useEffect, useState, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { fetchTrafficData, type TrafficData } from '@/lib/analytics';
import { format, subDays, startOfDay, endOfDay, isWithinInterval, startOfMonth, endOfMonth, eachDayOfInterval } from 'date-fns';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { Globe, Users, Clock } from 'lucide-react';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { DateRange } from 'react-day-picker';

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8'];

export default function TrafficAnalyticsPage() {
    const [loading, setLoading] = useState(true);
    const [traffic, setTraffic] = useState<TrafficData[]>([]);
    const [dateRange, setDateRange] = useState<DateRange | undefined>({
        from: subDays(new Date(), 7),
        to: new Date(),
    });
    const [filterType, setFilterType] = useState<'today' | '7days' | 'month' | 'custom'>('7days');

    useEffect(() => {
        const loadData = async () => {
            setLoading(true);
            try {
                const data = await fetchTrafficData();
                setTraffic(data);
            } catch (error) {
                console.error('Error fetching traffic:', error);
            } finally {
                setLoading(false);
            }
        };
        loadData();
    }, []);

    // Filter handlers
    const setFilter = (type: 'today' | '7days' | 'month') => {
        setFilterType(type);
        const now = new Date();
        if (type === 'today') {
            setDateRange({ from: startOfDay(now), to: endOfDay(now) });
        } else if (type === '7days') {
            setDateRange({ from: subDays(now, 6), to: now });
        } else if (type === 'month') {
            setDateRange({ from: startOfMonth(now), to: endOfMonth(now) });
        }
    };

    const filteredData = useMemo(() => {
        if (!dateRange?.from || !dateRange?.to) return traffic;

        return traffic.filter((item) => {
            // Use createdAt if available, otherwise sessionStart
            const date = item.createdAt?.toDate ? item.createdAt.toDate() : new Date(item.createdAt || item.sessionStart);
            return isWithinInterval(date, { start: dateRange.from!, end: dateRange.to! });
        });
    }, [traffic, dateRange]);

    // Metrics
    const metrics = useMemo(() => {
        const sessions = filteredData.length;
        const uniqueVisitors = new Set(filteredData.map((d) => d.phone || d.sessionId)).size;
        const totalDuration = filteredData.reduce((acc, d) => acc + (d.sessionDuration || 0), 0);
        const avgDuration = sessions > 0 ? totalDuration / sessions : 0;

        return {
            totalVisits: sessions,
            uniqueVisitors,
            avgDuration: Math.round(avgDuration),
        };
    }, [filteredData]);

    // Chart Data: Volume Trend
    const chartData = useMemo(() => {
        if (!dateRange?.from || !dateRange?.to) return [];

        const days = eachDayOfInterval({ start: dateRange.from, end: dateRange.to });
        return days.map((day) => {
            const dayStr = format(day, 'MMM d');
            const count = filteredData.filter((d) => {
                const date = d.createdAt?.toDate ? d.createdAt.toDate() : new Date(d.createdAt || d.sessionStart);
                return format(date, 'yyyy-MM-dd') === format(day, 'yyyy-MM-dd');
            }).length;
            return { name: dayStr, visits: count };
        });
    }, [filteredData, dateRange]);

    // Chart Data: Device Type
    const deviceData = useMemo(() => {
        const counts: Record<string, number> = { mobile: 0, desktop: 0, tablet: 0 };
        filteredData.forEach((d) => {
            if (d.deviceType) counts[d.deviceType]++;
        });
        return Object.entries(counts).map(([name, value]) => ({ name, value }));
    }, [filteredData]);

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold">Traffic Analytics</h1>
                    <p className="text-muted-foreground">Detailed insights into all app visits and behavior</p>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                    <Button variant={filterType === 'today' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('today')}>Today</Button>
                    <Button variant={filterType === '7days' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('7days')}>7 Days</Button>
                    <Button variant={filterType === 'month' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('month')}>Month</Button>
                    <DateRangePicker
                        initialDateRange={dateRange}
                        onDateChange={(r: DateRange | undefined) => {
                            if (r) {
                                setDateRange(r);
                                setFilterType('custom');
                            }
                        }}
                    />
                </div>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Total Visits</CardTitle>
                        <Globe className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{metrics.totalVisits.toLocaleString()}</div>
                        <p className="text-xs text-muted-foreground mt-1">Total sessions in selected range</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Unique Visitors</CardTitle>
                        <Users className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{metrics.uniqueVisitors.toLocaleString()}</div>
                        <p className="text-xs text-muted-foreground mt-1">Based on session/phone IDs</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Avg Session Duration</CardTitle>
                        <Clock className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{metrics.avgDuration}s</div>
                        <p className="text-xs text-muted-foreground mt-1">Average time spent per visit</p>
                    </CardContent>
                </Card>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Main Volume Chart */}
                <Card className="lg:col-span-2">
                    <CardHeader>
                        <CardTitle>Traffic Volume</CardTitle>
                        <CardDescription>Daily visit trends</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <ResponsiveContainer width="100%" height={300}>
                            <LineChart data={chartData}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                                <XAxis dataKey="name" />
                                <YAxis />
                                <Tooltip />
                                <Line type="monotone" dataKey="visits" stroke="#8884d8" strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                            </LineChart>
                        </ResponsiveContainer>
                    </CardContent>
                </Card>

                {/* Device Type Chart */}
                <Card>
                    <CardHeader>
                        <CardTitle>Device Distribution</CardTitle>
                        <CardDescription>Visits by platform</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <ResponsiveContainer width="100%" height={300}>
                            <PieChart>
                                <Pie
                                    data={deviceData}
                                    cx="50%"
                                    cy="50%"
                                    label={({ name, percent }: { name: string, percent: number }) => `${name} ${(percent * 100).toFixed(0)}%`}
                                    outerRadius={80}
                                    fill="#8884d8"
                                    dataKey="value"
                                >
                                    {deviceData.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                    ))}
                                </Pie>
                                <Tooltip />
                            </PieChart>
                        </ResponsiveContainer>
                    </CardContent>
                </Card>
            </div>

            {/* Recent Activity Table */}
            <Card>
                <CardHeader>
                    <CardTitle>Recent Sessions</CardTitle>
                    <CardDescription>Detailed log of latest app visits</CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b text-muted-foreground font-medium">
                                    <th className="text-left py-3 px-2">Time</th>
                                    <th className="text-left py-3 px-2">Visitor</th>
                                    <th className="text-left py-3 px-2">Duration</th>
                                    <th className="text-left py-3 px-2">Device</th>
                                    <th className="text-left py-3 px-2">Source</th>
                                    <th className="text-left py-3 px-2">Entry Page</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredData.slice(0, 50).map((session) => {
                                    const date = session.createdAt?.toDate ? session.createdAt.toDate() : new Date(session.createdAt || session.sessionStart);
                                    return (
                                        <tr key={session.id} className="border-b hover:bg-muted/50 transition-colors">
                                            <td className="py-3 px-2">{format(date, 'MMM d, HH:mm')}</td>
                                            <td className="py-3 px-2 font-medium">
                                                {session.phone || <span className="text-muted-foreground text-xs">{session.sessionId.split('_')[1]}</span>}
                                            </td>
                                            <td className="py-3 px-2">{session.sessionDuration}s</td>
                                            <td className="py-3 px-2">
                                                <Badge variant="outline" className="capitalize">{session.deviceType}</Badge>
                                            </td>
                                            <td className="py-3 px-2 max-w-[150px] truncate" title={session.referrer}>
                                                {session.referrer.includes('direct') ? 'Direct' : (session.referrer.split('/')[2] || session.referrer)}
                                            </td>
                                            <td className="py-3 px-2 text-muted-foreground">{session.entryPage}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
