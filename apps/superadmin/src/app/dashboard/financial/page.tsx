'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchAllClinics, fetchAllAppointments } from '@/lib/analytics';
import { format, subMonths, startOfMonth, endOfMonth } from 'date-fns';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { DollarSign, TrendingUp, Users, Building2 } from 'lucide-react';
import type { Clinic, Appointment } from '@/lib/analytics';

export default function FinancialPage() {
  const [loading, setLoading] = useState(true);
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [projections, setProjections] = useState({
    currentMRR: 0,
    projectedMRR: 0,
    projectedARR: 0,
    ltv: 0,
    cac: 0,
    ltvCacRatio: 0,
  });

  // Pricing tiers (example - adjust based on your pricing)
  const PRICING_TIERS = {
    free: 0,
    basic: 999,
    professional: 2999,
    enterprise: 5000,
  };

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const [clinicsData, appointmentsData] = await Promise.all([
          fetchAllClinics(),
          fetchAllAppointments(),
        ]);

        setClinics(clinicsData);
        setAppointments(appointmentsData);

        // Calculate financial projections
        // Assume current clinics are on "basic" tier for projection
        const activeClinics = clinicsData.filter(c => c.onboardingStatus === 'Completed').length;
        const currentMRR = activeClinics * PRICING_TIERS.basic;
        
        // Projection: assume 20 clinics in 3 months, 50 in 6 months, 100 in 12 months
        const projectedClinics = {
          month3: 20,
          month6: 50,
          month12: 100,
        };
        
        const projectedMRR = projectedClinics.month12 * PRICING_TIERS.basic;
        const projectedARR = projectedMRR * 12;

        // Unit economics (example values - adjust based on your data)
        // CAC: Assume ₹5,000 per clinic acquisition
        const cac = 5000;
        
        // LTV: Average clinic stays 24 months, paying ₹999/month
        const ltv = PRICING_TIERS.basic * 24;
        
        const ltvCacRatio = cac > 0 ? ltv / cac : 0;

        setProjections({
          currentMRR,
          projectedMRR,
          projectedARR,
          ltv,
          cac,
          ltvCacRatio,
        });
      } catch (error) {
        console.error('Error loading financial data:', error);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, []);

  // Calculate GMV (Gross Merchandise Value) - total consultation fees processed
  const calculateGMV = () => {
    // Estimate average consultation fee (you can get this from doctors data)
    const avgConsultationFee = 300; // ₹300 per consultation
    return appointments.length * avgConsultationFee;
  };

  // Monthly revenue projection chart
  const revenueProjection = (() => {
    const months = [];
    const now = new Date();
    const activeClinics = clinics.filter(c => c.onboardingStatus === 'Completed').length;
    
    for (let i = 0; i <= 12; i++) {
      const monthDate = subMonths(now, -i); // Future months
      const monthName = format(monthDate, 'MMM yyyy');
      
      // Linear growth projection
      const projectedClinics = Math.round(activeClinics + (i * 8)); // Rough estimate
      const mrr = projectedClinics * PRICING_TIERS.basic;
      const arr = mrr * 12;
      
      months.push({
        month: monthName,
        clinics: projectedClinics,
        mrr,
        arr,
      });
    }
    
    return months;
  })();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto mb-4" />
          <p className="text-muted-foreground">Loading financial projections...</p>
        </div>
      </div>
    );
  }

  const activeClinics = clinics.filter(c => c.onboardingStatus === 'Completed').length;
  const gmv = calculateGMV();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Financial Projections</h1>
        <p className="text-muted-foreground mt-1">Revenue forecasts and unit economics</p>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Current MRR</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">₹{projections.currentMRR.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {activeClinics} active clinics
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Projected MRR</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">₹{projections.projectedMRR.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">
              At 100 clinics (12 months)
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Projected ARR</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">₹{projections.projectedARR.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Annual recurring revenue
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">GMV (All Time)</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">₹{gmv.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Total consultation fees
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Unit Economics */}
      <Card>
        <CardHeader>
          <CardTitle>Unit Economics</CardTitle>
          <CardDescription>Key financial metrics for investor presentations</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Customer Acquisition Cost (CAC)</p>
              <p className="text-2xl font-bold">₹{projections.cac.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Lifetime Value (LTV)</p>
              <p className="text-2xl font-bold">₹{projections.ltv.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">LTV:CAC Ratio</p>
              <p className={`text-2xl font-bold ${projections.ltvCacRatio >= 3 ? 'text-green-600' : 'text-yellow-600'}`}>
                {projections.ltvCacRatio.toFixed(1)}:1
              </p>
              {projections.ltvCacRatio >= 3 && (
                <p className="text-xs text-green-600 mt-1">✅ Healthy ratio</p>
              )}
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Payback Period</p>
              <p className="text-2xl font-bold">
                {projections.currentMRR > 0 ? Math.ceil(projections.cac / projections.currentMRR) : 0} months
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Revenue Projection Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Revenue Projection</CardTitle>
          <CardDescription>12-month forecast based on clinic growth</CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={400}>
            <LineChart data={revenueProjection}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" angle={-45} textAnchor="end" height={100} />
              <YAxis />
              <Tooltip formatter={(value: number) => `₹${value.toLocaleString()}`} />
              <Legend />
              <Line 
                type="monotone" 
                dataKey="mrr" 
                stroke="#8884d8" 
                strokeWidth={2}
                name="Monthly Recurring Revenue (MRR)"
              />
              <Line 
                type="monotone" 
                dataKey="arr" 
                stroke="#82ca9d" 
                strokeWidth={2}
                name="Annual Recurring Revenue (ARR)"
                strokeDasharray="5 5"
              />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Growth Scenarios */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Conservative (50 Clinics)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div>
                <p className="text-sm text-muted-foreground">MRR</p>
                <p className="text-xl font-bold">₹{(50 * PRICING_TIERS.basic).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">ARR</p>
                <p className="text-xl font-bold">₹{(50 * PRICING_TIERS.basic * 12).toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Realistic (100 Clinics)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div>
                <p className="text-sm text-muted-foreground">MRR</p>
                <p className="text-xl font-bold">₹{(100 * PRICING_TIERS.basic).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">ARR</p>
                <p className="text-xl font-bold">₹{(100 * PRICING_TIERS.basic * 12).toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Optimistic (200 Clinics)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div>
                <p className="text-sm text-muted-foreground">MRR</p>
                <p className="text-xl font-bold">₹{(200 * PRICING_TIERS.basic).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">ARR</p>
                <p className="text-xl font-bold">₹{(200 * PRICING_TIERS.basic * 12).toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Note */}
      <Card className="border-yellow-200 bg-yellow-50">
        <CardContent className="p-4">
          <p className="text-sm text-yellow-800">
            <strong>Note:</strong> These projections are based on estimated pricing tiers (₹999/month for Basic plan). 
            Actual revenue will depend on your pricing strategy, clinic adoption rates, and churn. 
            Adjust pricing tiers in the code to match your business model.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
