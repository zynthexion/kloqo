'use client';

import { useEffect, useState, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchAllClinics, fetchAllAppointments } from '@/lib/analytics';
import { format, subMonths, startOfMonth, endOfMonth, eachMonthOfInterval } from 'date-fns';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell, AreaChart, Area
} from 'recharts';
import {
  DollarSign, TrendingUp, Users, Building2, UserPlus,
  Briefcase, Target, PieChart as PieChartIcon, ArrowUpRight,
  Tv, Heart, Shield
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Info } from 'lucide-react';

// Glossary of terms in simple English
const GLOSSARY: Record<string, string> = {
  MRR: "Monthly Recurring Revenue - The predictable revenue Kloqo earns every month from subscriptions and fees.",
  ARR: "Annual Recurring Revenue - Your MRR multiplied by 12. It shows what your yearly revenue would be at the current scale.",
  GMV: "Gross Merchandise Value - The total value of all doctor consultations processed through Kloqo.",
  "Patient Reach": "The total number of unique patients who have booked appointments using Kloqo.",
  LTV: "Lifetime Value - The total profit expected from a single clinic over the entire time they use Kloqo.",
  CAC: "Customer Acquisition Cost - The money spent on marketing and sales to sign up one new clinic.",
  "Payback Period": "How many months of profit it takes to recover the money spent to acquire a clinic.",
  "Rule of 40": "Growth % + Profit %. A score of 40% is healthy. A negative score means high burn vs low revenue. To improve: Increase Growth Rate or reduce OpEx/Headcount.",
  NRR: "Net Revenue Retention - How much revenue you keep from existing clinics after accounting for upgrades and cancellations.",
  TAM: "Total Addressable Market - The total revenue opportunity if every single clinic in India used Kloqo.",
  SAM: "Serviceable Addressable Market - The revenue opportunity from clinics that are a perfect fit for Kloqo today.",
  SOM: "Serviceable Obtainable Market - The portion of the market Kloqo can realistically capture in the next 2-3 years.",
  "Contribution Margin": "The profit made per clinic after paying for direct costs like SMS and Cloud hosting.",
  Burn: "The total money spent on operations (Salaries, Rent, Tech) before earning profit.",
  // New Terms
  "MoM Growth Rate": "Month-over-Month Growth - The percentage increase in new clinics joining Kloqo each month.",
  "Starting Clinics": "The baseline number of clinics to start the financial projection with (simulated).",
  "Monthly Churn": "The percentage of clinics that cancel their subscription each month.",
  "Base Subscription": "The fixed monthly fee charged to each clinic for using the platform.",
  "Token Fee": "The fee Kloqo earns for every walk-in appointment processed (usage-based).",
  "Ad Rev / TV": "Revenue earned from pharmaceutical ads displayed on the clinic's reception TV.",
  "Passport Fee": "Subscription fee paid by patients for the 'Kloqo Health Passport' (premium features).",
  "TV Adopt %": "Percentage of clinics that install the Reception TV hardware.",
  "Passport %": "Percentage of patients that upgrade to the paid Health Passport.",
  "Onboard Fee": "One-time setup fee charged to new clinics during implementation.",
  "Hardware Margin": "Profit made on the sale/installation of the Reception TV hardware.",
  "Gateway %": "Payment Processing Fee - Percentage taken by Razorpay/Stripe for facilitating transactions.",
  "SMS (₹/pt)": "Cost of sending OTPs and appointment reminders per patient interaction.",
  "Cloud/Clinic": "Hosting Cost - The server and database costs attributed to supporting one single clinic.",
  "Supp./Clinic": "Support Cost - The human resource cost of customer support agents per clinic.",
  "Onboarding Cost": "The internal cost (training, logistics) to set up a new clinic.",
  "Avg CAC": "Average cost to acquire a customer via paid marketing channels (Ads, Events).",
  "Headcount": "Total number of full-time employees on the payroll.",
  "Avg Salary": "The average monthly salary cost per employee.",
  "Sales Comm %": "Sales Commission - Percentage of the first year's contract value paid to sales reps.",
  "Mktg (Fixed)": "Fixed monthly marketing budget for brand awareness and content (not direct ads).",
  "Office Rent": "Monthly cost for office space and utilities.",
  "SaaS/User": "Cost of software licenses (Jira, Slack, Figma) per employee.",
  "Legal/Admin": "Monthly budget for accounting, legal compliance, and administrative overhead.",
  "Total Clinics (TAM)": "The absolute total number of potential clinics in the target geography.",
  "Target Capture %": "The realistic percentage of the market we aim to win in the next 3-5 years."
};

const InfoTooltip = ({ term }: { term: string }) => (
  <div className="group relative inline-flex ml-1 align-middle">
    <Info className="h-3 w-3 text-muted-foreground/50 cursor-help hover:text-primary transition-colors" />
    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 p-2 bg-slate-900 text-white text-[10px] rounded shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 pointer-events-none text-center">
      {GLOSSARY[term] || "Financial metric for analysis."}
      <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-slate-900" />
    </div>
  </div>
);

// Types
type TabType = 'overview' | 'cohorts' | 'playbook' | 'seed' | 'market' | 'planning';

export default function FinancialPage() {
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [loading, setLoading] = useState(true);
  const [clinics, setClinics] = useState<any[]>([]);
  const [appointments, setAppointments] = useState<any[]>([]);

  // Interactive Valuation State
  const [mrrMultiple, setMrrMultiple] = useState(10);

  // Seed / Traction Tab State
  const [seedScenario, setSeedScenario] = useState({
    paying: 5,
    testing: 10,
    pilotPrice: 999, // Discounted price for beta
  });

  const [seedFundraising, setSeedFundraising] = useState({
    askAmount: 5000000, // 50 Lakhs
    equityOffered: 10,  // 10%
  });

  // Investor Playbook Assumptions
  const [assumptions, setAssumptions] = useState({
    // Growth
    startingClinics: 5, // Baseline for simulation
    growthRate: 20,
    monthlyChurn: 1,
    ltvMonths: 36,

    // COGS (Variable)
    paymentGateway: 2, // % of Gross Revenue
    smsCost: 0.40,     // per patient
    hostingCost: 500,  // per clinic
    supportCost: 197,  // per clinic
    onboardingCost: 500, // per new clinic (one-time)

    // OpEx (Fixed/Semi-Fixed)
    staffCount: 6,
    avgSalary: 60000,
    salesCommission: 7, // % of New ARR
    marketingFixed: 49996, // Monthly Brand/Ads
    officeRent: 10000,
    softwarePerUser: 5000, // per staff member
    legalAdmin: 20000,     // Accounting/Legal
    otherOverhead: 10000,  // Misc
    avgCac: 5500,          // Paid Marketing CAC
  });

  // Dynamic Pricing & Plans
  const [pricing, setPricing] = useState({
    // Recurring
    subscription: 3000,
    tokenFee: 10,
    adRevenue: 3000,
    healthPass: 10,

    // One-Time
    onboardingFee: 5000,
    hardwareMargin: 2000, // Profit on TV hardware (Assumed 20% of 10k based on user input '20')

    // Adoption
    adAdoption: 20, // %
    passportAdoption: 10, // %
  });

  // Market & Fundraising Assumptions
  const [marketAssumptions, setMarketAssumptions] = useState({
    totalClinicsIndia: 1000000,
    serviceableClinics: 50000, // Tech-forward urban clinics
    targetCapture: 50, // % of SAM
    roundSize: 50000000, // ₹5Cr Series A
  });

  const [useOfFunds, setUseOfFunds] = useState({
    product: 40,
    sales: 30,
    marketing: 20,
    operations: 10,
  });

  const [valuationMarket, setValuationMarket] = useState<'Global' | 'India'>('India');

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
      } catch (error) {
        console.error('Error loading financial data:', error);
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, []);

  // 1. Revenue Calculations
  const metrics = useMemo(() => {
    const activeClinics = clinics.filter(c => c.onboardingStatus === 'Completed').length;
    const totalPatients = new Set(appointments.map(a => a.patientId)).size;

    // Monthly calculation
    const subRevenue = activeClinics * pricing.subscription;
    const tokenRevenue = appointments.filter(a => a.status === 'Completed').length * pricing.tokenFee;
    const adRevenue = activeClinics * (pricing.adAdoption / 100) * pricing.adRevenue;
    const patientRevenue = totalPatients * (pricing.passportAdoption / 100) * pricing.healthPass;

    const mrr = subRevenue + tokenRevenue + adRevenue + patientRevenue;

    return {
      activeClinics,
      totalPatients,
      mrr,
      arr: mrr * 12,
      breakdown: [
        { name: 'Subscriptions', value: subRevenue, color: '#3b82f6' },
        { name: 'Token Fees', value: tokenRevenue, color: '#22c55e' },
        { name: 'TV Ads', value: adRevenue, color: '#a855f7' },
        { name: 'Health Passport', value: patientRevenue, color: '#f97316' },
      ],
      gmv: appointments.length * 300 // Avg 300 per consultation
    };
  }, [clinics, appointments]);

  // 2. P&L & Runway Modeler Logic
  const pnlProjections = useMemo(() => {
    const projection = [];
    // User Override: Use the higher of Live Data OR Simulation Input
    let currentClinics = Math.max(metrics.activeClinics, assumptions.startingClinics);

    for (let i = 1; i <= 12; i++) {
      // 1. Growth Engine
      const newClinics = Math.round(currentClinics * (assumptions.growthRate / 100));
      const churnedClinics = Math.round(currentClinics * (assumptions.monthlyChurn / 100));
      const startingClinics = currentClinics;
      currentClinics = currentClinics + newClinics - churnedClinics;

      // 2. Detailed Revenue Logic
      // Recurring
      const revSub = currentClinics * pricing.subscription;
      const revTokens = currentClinics * 45 * 25 * pricing.tokenFee; // 45 tokens/day * 25 days assumption
      const revAds = currentClinics * (pricing.adAdoption / 100) * pricing.adRevenue;
      const revPassport = currentClinics * 100 * (pricing.passportAdoption / 100) * pricing.healthPass; // 100 patients/mo assumption
      const recurringRev = revSub + revTokens + revAds + revPassport;

      // One-Time
      const revOnboarding = newClinics * pricing.onboardingFee;
      const revHardware = newClinics * pricing.hardwareMargin;
      const oneTimeRev = revOnboarding + revHardware;

      const totalRev = recurringRev + oneTimeRev;

      // 3. COGS (Variable Costs)
      const costGateway = totalRev * (assumptions.paymentGateway / 100);
      const costSms = currentClinics * 45 * 25 * assumptions.smsCost;
      const costHosting = currentClinics * assumptions.hostingCost;
      const costSupport = currentClinics * assumptions.supportCost;
      const costOnboarding = newClinics * assumptions.onboardingCost; // Fulfillment/Training

      const totalCOGS = costGateway + costSms + costHosting + costSupport + costOnboarding;
      const grossProfit = totalRev - totalCOGS;

      // 4. OpEx (Operating Expenses)
      // Sales & Marketing (CAC)
      const costPaidMarketing = newClinics * assumptions.avgCac;
      const costBrandMarketing = assumptions.marketingFixed;
      const newARR = (newClinics * pricing.subscription * 12);
      const costCommissions = newARR * (assumptions.salesCommission / 100);

      // G&A / R&D
      const costStaff = assumptions.staffCount * assumptions.avgSalary;
      const costTechStack = assumptions.staffCount * assumptions.softwarePerUser;
      const costFacilities = assumptions.officeRent + assumptions.legalAdmin + assumptions.otherOverhead;

      const totalOpEx = costPaidMarketing + costBrandMarketing + costCommissions + costStaff + costTechStack + costFacilities;

      projection.push({
        month: `Month ${i}`,
        clinics: currentClinics,
        revenue: totalRev,
        cogs: totalCOGS,
        grossProfit: grossProfit,
        opex: totalOpEx,
        profit: grossProfit - totalOpEx, // Net Profit
        margin: ((grossProfit - totalOpEx) / totalRev) * 100,
        breakdown: {
          staff: costStaff,
          marketing: costPaidMarketing + costBrandMarketing,
          tech: costTechStack + costHosting
        }
      });
    }

    // SaaS efficiency metrics (based on Month 1 run-rate for simplicity)
    const avgMonthlyRevPerClinic = pricing.subscription + (45 * 25 * pricing.tokenFee);
    const avgMonthlyGrossProfit = avgMonthlyRevPerClinic - (avgMonthlyRevPerClinic * (assumptions.paymentGateway / 100) + (45 * 25 * assumptions.smsCost) + assumptions.hostingCost + assumptions.supportCost);

    // LTV based on Gross Profit, not Revenue (More accurate)
    const ltv = avgMonthlyGrossProfit * assumptions.ltvMonths;
    const ltvCac = ltv / assumptions.avgCac;
    const payback = assumptions.avgCac / avgMonthlyGrossProfit;

    // 4. Market Metrics
    const tam = marketAssumptions.totalClinicsIndia * (pricing.subscription * 12);
    const sam = marketAssumptions.serviceableClinics * (pricing.subscription * 12);
    const som = sam * (marketAssumptions.targetCapture / 100);

    // Rule of 40 = Growth Rate + Profit Margin
    const growthMoM = assumptions.growthRate;
    const currentMargin = projection[0]?.margin || 0;
    const ruleOf40 = growthMoM + currentMargin;

    return {
      projection,
      efficiency: { ltv, ltvCac, payback },
      market: { tam, sam, som },
      ruleOf40
    };
  }, [metrics.activeClinics, assumptions, pricing, marketAssumptions]);
  // 3. Cohort Analytics (Mock Data for structure)
  const cohortData = [
    { month: 'Jan 2024', size: 10, m1: 100, m2: 90, m3: 80, m4: 80, m5: 70, m6: 70 },
    { month: 'Feb 2024', size: 15, m1: 100, m2: 93, m3: 86, m4: 80, m5: 80 },
    { month: 'Mar 2024', size: 20, m1: 100, m2: 95, m3: 90, m4: 90 },
    { month: 'Apr 2024', size: 25, m1: 100, m2: 96, m3: 92 },
    { month: 'May 2024', size: 30, m1: 100, m2: 98 },
    { month: 'Jun 2024', size: 35, m1: 100 },
  ];

  // 4. Hiring Roadmap
  const hiringPlan = [
    { role: 'Founder/CEO', time: 'Month 1', status: 'Active', icon: Building2 },
    { role: 'Level A Funding', time: 'Month 6', status: 'Planned', icon: Target },
    { role: 'CTO (Architect)', time: 'Month 7', status: 'Planned', icon: UserPlus },
    { role: 'Lead Dev (NextJS)', time: 'Month 8', status: 'Planned', icon: Briefcase },
    { role: 'Sales Head', time: 'Month 8', status: 'Planned', icon: Users },
    { role: 'Mobile Dev', time: 'Year 2', status: 'Planned', icon: Briefcase },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-pulse flex flex-col items-center">
          <div className="h-12 w-12 rounded-full bg-primary/20 mb-4" />
          <p className="text-muted-foreground">Calculating financial models...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 p-4 md:p-8 text-slate-900">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl font-extrabold tracking-tight">Financial Suite</h1>
          <p className="text-muted-foreground mt-2 text-lg">Live metrics, cohort retention, and scenario modeling.</p>
        </div>
        <div className="flex p-1 bg-muted rounded-xl gap-1 self-start flex-wrap">
          {(['overview', 'cohorts', 'seed', 'playbook', 'market', 'planning'] as TabType[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all capitalize ${activeTab === tab ? 'bg-white shadow-sm text-primary' : 'hover:bg-white/50 text-muted-foreground'}`}
            >
              {tab === 'playbook' ? 'Investor Playbook' : tab === 'market' ? 'Market & Fund' : tab}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        {/* Sticky Control Sidebar */}
        <aside className="lg:col-span-1 space-y-6">
          <div className="sticky top-8 space-y-6">
            <Card className="border-none shadow-md bg-slate-900 text-white overflow-hidden">
              <CardHeader className="pb-2 border-b border-slate-800">
                <CardTitle className="text-lg flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-blue-400" />
                  Global Controller
                </CardTitle>
                <CardDescription className="text-slate-400 text-xs text-balance">Any change here updates everything.</CardDescription>
              </CardHeader>
              <CardContent className="pt-6 space-y-8 max-h-[calc(100vh-250px)] overflow-y-auto custom-scrollbar">
                {/* 1. Growth & Adoption */}
                <div className="space-y-4">
                  <h4 className="text-xs font-black uppercase text-slate-500 flex items-center gap-2">
                    <Building2 className="h-3 w-3" /> Growth & Scale
                  </h4>
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <div className="flex justify-between text-[11px]">
                        <label className="flex items-center">Starting Clinics <span className="text-slate-500 ml-1">(Baseline)</span> <InfoTooltip term="Starting Clinics" /></label>
                        <span className="font-bold text-white">{assumptions.startingClinics}</span>
                      </div>
                      <input type="range" min="1" max="100" value={assumptions.startingClinics} onChange={e => setAssumptions({ ...assumptions, startingClinics: Number(e.target.value) })} className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-emerald-500" />
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between text-[11px]">
                        <label className="flex items-center">MoM Growth Rate <span className="text-slate-500 ml-1">(Avg: 15-20%)</span> <InfoTooltip term="MoM Growth Rate" /></label>
                        <span className="font-bold text-blue-400">{assumptions.growthRate}%</span>
                      </div>
                      <input type="range" min="1" max="50" value={assumptions.growthRate} onChange={e => setAssumptions({ ...assumptions, growthRate: Number(e.target.value) })} className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between text-[11px]">
                        <label className="flex items-center">Monthly Churn <span className="text-slate-500 ml-1">(Avg: &lt; 2%)</span> <InfoTooltip term="Monthly Churn" /></label>
                        <span className="font-bold text-red-400">{assumptions.monthlyChurn}%</span>
                      </div>
                      <input type="range" min="0" max="10" step="0.5" value={assumptions.monthlyChurn} onChange={e => setAssumptions({ ...assumptions, monthlyChurn: Number(e.target.value) })} className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-red-500" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400 flex items-center">TV Adopt % <span className="ml-1 text-slate-600">(20%)</span> <InfoTooltip term="TV Adopt %" /></label>
                        <input type="number" value={pricing.adAdoption} onChange={e => setPricing({ ...pricing, adAdoption: Number(e.target.value) })} className="w-full h-8 bg-slate-800 border-none rounded text-xs px-2 text-white" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400 flex items-center">Passport % <span className="ml-1 text-slate-600">(10%)</span> <InfoTooltip term="Passport %" /></label>
                        <input type="number" value={pricing.passportAdoption} onChange={e => setPricing({ ...pricing, passportAdoption: Number(e.target.value) })} className="w-full h-8 bg-slate-800 border-none rounded text-xs px-2 text-white" />
                      </div>
                    </div>
                  </div>
                </div>

                {/* 2. Revenue Model */}
                <div className="space-y-4 pt-4 border-t border-slate-800">
                  <h4 className="text-xs font-black uppercase text-slate-500 flex items-center gap-2">
                    <DollarSign className="h-3 w-3" /> Revenue Model
                  </h4>
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <div className="flex justify-between text-[11px]">
                        <label className="flex items-center">Base Subscription (₹) <span className="text-slate-500 ml-1">(Avg: ₹2-5k)</span> <InfoTooltip term="Base Subscription" /></label>
                        <span className="font-bold text-blue-400">₹{pricing.subscription}</span>
                      </div>
                      <input type="range" min="500" max="15000" step="100" value={pricing.subscription} onChange={e => setPricing({ ...pricing, subscription: Number(e.target.value) })} className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between text-[11px]">
                        <label className="flex items-center">Token Fee (₹) <span className="text-slate-500 ml-1">(Avg: ₹5-15)</span> <InfoTooltip term="Token Fee" /></label>
                        <span className="font-bold text-blue-400">₹{pricing.tokenFee}</span>
                      </div>
                      <input type="range" min="0" max="50" step="1" value={pricing.tokenFee} onChange={e => setPricing({ ...pricing, tokenFee: Number(e.target.value) })} className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400 flex items-center">Onboard Fee <span className="text-slate-600 ml-1">(₹5k)</span> <InfoTooltip term="Onboard Fee" /></label>
                        <input type="number" value={pricing.onboardingFee} onChange={e => setPricing({ ...pricing, onboardingFee: Number(e.target.value) })} className="w-full h-8 bg-slate-800 border-none rounded text-xs px-2 text-white" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400 flex items-center">Hardware Mgn <span className="text-slate-600 ml-1">(20%)</span> <InfoTooltip term="Hardware Margin" /></label>
                        <input type="number" value={pricing.hardwareMargin} onChange={e => setPricing({ ...pricing, hardwareMargin: Number(e.target.value) })} className="w-full h-8 bg-slate-800 border-none rounded text-xs px-2 text-white" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400 flex items-center">Ad Rev / TV <span className="text-slate-600 ml-1">(₹3k)</span> <InfoTooltip term="Ad Rev / TV" /></label>
                        <input type="number" value={pricing.adRevenue} onChange={e => setPricing({ ...pricing, adRevenue: Number(e.target.value) })} className="w-full h-8 bg-slate-800 border-none rounded text-xs px-2 text-white" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400 flex items-center">Passport Fee <span className="text-slate-600 ml-1">(₹10)</span> <InfoTooltip term="Passport Fee" /></label>
                        <input type="number" value={pricing.healthPass} onChange={e => setPricing({ ...pricing, healthPass: Number(e.target.value) })} className="w-full h-8 bg-slate-800 border-none rounded text-xs px-2 text-white" />
                      </div>
                    </div>
                  </div>
                </div>

                {/* 3. COGS (Variable) */}
                <div className="space-y-4 pt-4 border-t border-slate-800">
                  <h4 className="text-xs font-black uppercase text-slate-500 flex items-center gap-2">
                    <PieChartIcon className="h-3 w-3" /> COGS (Variable)
                  </h4>
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400 flex items-center">Gateway % <span className="text-slate-600 ml-1">(2%)</span> <InfoTooltip term="Gateway %" /></label>
                        <input type="number" value={assumptions.paymentGateway} onChange={e => setAssumptions({ ...assumptions, paymentGateway: Number(e.target.value) })} className="w-full h-8 bg-slate-800 border-none rounded text-xs px-2 text-white" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400 flex items-center">SMS (₹/pt) <span className="text-slate-600 ml-1">(0.20)</span> <InfoTooltip term="SMS (₹/pt)" /></label>
                        <input type="number" step="0.05" value={assumptions.smsCost} onChange={e => setAssumptions({ ...assumptions, smsCost: Number(e.target.value) })} className="w-full h-8 bg-slate-800 border-none rounded text-xs px-2 text-white" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400 flex items-center">Cloud/Clinic <span className="text-slate-600 ml-1">(₹500)</span> <InfoTooltip term="Cloud/Clinic" /></label>
                        <input type="number" value={assumptions.hostingCost} onChange={e => setAssumptions({ ...assumptions, hostingCost: Number(e.target.value) })} className="w-full h-8 bg-slate-800 border-none rounded text-xs px-2 text-white" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400 flex items-center">Supp./Clinic <span className="text-slate-600 ml-1">(₹200)</span> <InfoTooltip term="Supp./Clinic" /></label>
                        <input type="number" value={assumptions.supportCost} onChange={e => setAssumptions({ ...assumptions, supportCost: Number(e.target.value) })} className="w-full h-8 bg-slate-800 border-none rounded text-xs px-2 text-white" />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-slate-400 flex items-center">Onboarding Cost <span className="text-slate-600 ml-1">(₹3k)</span> <InfoTooltip term="Onboarding Cost" /></label>
                      <input type="number" value={assumptions.onboardingCost} onChange={e => setAssumptions({ ...assumptions, onboardingCost: Number(e.target.value) })} className="w-full h-8 bg-slate-800 border-none rounded text-xs px-2 text-white" />
                    </div>
                  </div>
                </div>

                {/* 4. OpEx (Fixed) */}
                <div className="space-y-4 pt-4 border-t border-slate-800">
                  <h4 className="text-xs font-black uppercase text-slate-500 flex items-center gap-2">
                    <Heart className="h-3 w-3" /> OpEx & Burn
                  </h4>
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <div className="flex justify-between text-[11px]">
                        <label className="flex items-center">Avg CAC (₹) <span className="text-slate-500 ml-1">(Avg: ₹5-15k)</span> <InfoTooltip term="Avg CAC" /></label>
                        <span className="font-bold text-red-400">₹{assumptions.avgCac}</span>
                      </div>
                      <input type="range" min="1000" max="25000" step="500" value={assumptions.avgCac} onChange={e => setAssumptions({ ...assumptions, avgCac: Number(e.target.value) })} className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-red-500" />
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between text-[11px]">
                        <label className="flex items-center">Headcount <span className="text-slate-500 ml-1">(3-5)</span> <InfoTooltip term="Headcount" /></label>
                        <span className="font-bold text-white">{assumptions.staffCount}</span>
                      </div>
                      <input type="range" min="1" max="100" value={assumptions.staffCount} onChange={e => setAssumptions({ ...assumptions, staffCount: Number(e.target.value) })} className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400 flex items-center">Avg Salary <span className="text-slate-600 ml-1">(₹1L)</span> <InfoTooltip term="Avg Salary" /></label>
                        <input type="number" value={assumptions.avgSalary} onChange={e => setAssumptions({ ...assumptions, avgSalary: Number(e.target.value) })} className="w-full h-8 bg-slate-800 border-none rounded text-xs px-2 text-white" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400 flex items-center">Sales Comm % <span className="text-slate-600 ml-1">(10%)</span> <InfoTooltip term="Sales Comm %" /></label>
                        <input type="number" value={assumptions.salesCommission} onChange={e => setAssumptions({ ...assumptions, salesCommission: Number(e.target.value) })} className="w-full h-8 bg-slate-800 border-none rounded text-xs px-2 text-white" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400 flex items-center">Mktg (Fixed) <span className="text-slate-600 ml-1">(₹50k)</span> <InfoTooltip term="Mktg (Fixed)" /></label>
                        <input type="number" value={assumptions.marketingFixed} onChange={e => setAssumptions({ ...assumptions, marketingFixed: Number(e.target.value) })} className="w-full h-8 bg-slate-800 border-none rounded text-xs px-2 text-white" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400 flex items-center">Office Rent <span className="text-slate-600 ml-1">(₹30k)</span> <InfoTooltip term="Office Rent" /></label>
                        <input type="number" value={assumptions.officeRent} onChange={e => setAssumptions({ ...assumptions, officeRent: Number(e.target.value) })} className="w-full h-8 bg-slate-800 border-none rounded text-xs px-2 text-white" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400 flex items-center">SaaS/User <span className="text-slate-600 ml-1">(₹5k)</span> <InfoTooltip term="SaaS/User" /></label>
                        <input type="number" value={assumptions.softwarePerUser} onChange={e => setAssumptions({ ...assumptions, softwarePerUser: Number(e.target.value) })} className="w-full h-8 bg-slate-800 border-none rounded text-xs px-2 text-white" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400 flex items-center">Legal/Admin <span className="text-slate-600 ml-1">(₹20k)</span> <InfoTooltip term="Legal/Admin" /></label>
                        <input type="number" value={assumptions.legalAdmin} onChange={e => setAssumptions({ ...assumptions, legalAdmin: Number(e.target.value) })} className="w-full h-8 bg-slate-800 border-none rounded text-xs px-2 text-white" />
                      </div>
                    </div>
                  </div>
                </div>

                {/* 5. Market Scale */}
                <div className="space-y-4 pt-4 border-t border-slate-800">
                  <h4 className="text-xs font-black uppercase text-slate-500 flex items-center gap-2">
                    <Target className="h-3 w-3" /> Market Scale
                  </h4>
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <label className="text-[10px] text-slate-400 flex items-center">Total Clinics (TAM) <span className="text-slate-600 ml-1">(1M)</span> <InfoTooltip term="Total Clinics (TAM)" /></label>
                      <input type="number" value={marketAssumptions.totalClinicsIndia} onChange={e => setMarketAssumptions({ ...marketAssumptions, totalClinicsIndia: Number(e.target.value) })} className="w-full h-8 bg-slate-800 border-none rounded text-xs px-2 text-white" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-slate-400 flex items-center">Target Capture % <span className="text-slate-600 ml-1">(10-20%)</span> <InfoTooltip term="Target Capture %" /></label>
                      <input type="number" value={marketAssumptions.targetCapture} onChange={e => setMarketAssumptions({ ...marketAssumptions, targetCapture: Number(e.target.value) })} className="w-full h-8 bg-slate-800 border-none rounded text-xs px-2 text-white" />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-blue-600/10 border-blue-500/20 text-blue-400 p-4">
              <div className="flex items-start gap-3">
                <Info className="h-4 w-4 shrink-0 mt-1" />
                <p className="text-[10px] leading-relaxed">
                  Every change here instantly recalibrates the entire Investor Playbook & Market models.
                </p>
              </div>
            </Card>
          </div>        </aside>

        {/* Main Reporting Area */}
        <main className="lg:col-span-3 space-y-8">
          {activeTab === 'overview' && (
            <div className="space-y-8 animate-in fade-in transition-all duration-500">
              {/* Main Key Stats */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <Card className="relative overflow-hidden group hover:shadow-lg transition-all border-none shadow-sm bg-gradient-to-br from-blue-500 to-blue-600">
                  <CardHeader className="pb-2">
                    <p className="text-blue-100 text-sm font-medium">Monthly Recurring Revenue <InfoTooltip term="MRR" /></p>
                    <CardTitle className="text-3xl font-bold text-white tracking-tighter">₹{metrics.mrr.toLocaleString()}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center text-blue-100 text-xs">
                      <ArrowUpRight className="h-3 w-3 mr-1" />
                      <span>Incl. Ads & Passport Streams</span>
                    </div>
                  </CardContent>
                  <DollarSign className="absolute -right-2 -bottom-2 h-24 w-24 text-white/10" />
                </Card>

                <Card className="relative overflow-hidden group hover:shadow-lg transition-all border-none shadow-sm bg-gradient-to-br from-emerald-500 to-emerald-600">
                  <CardHeader className="pb-2">
                    <p className="text-emerald-100 text-sm font-medium">Annual Revenue Runrate <InfoTooltip term="ARR" /></p>
                    <CardTitle className="text-3xl font-bold text-white tracking-tighter">₹{metrics.arr.toLocaleString()}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-emerald-100 text-xs">Projected current scale x12</div>
                  </CardContent>
                  <TrendingUp className="absolute -right-2 -bottom-2 h-24 w-24 text-white/10" />
                </Card>

                <Card className="relative overflow-hidden group hover:shadow-lg transition-all border-none shadow-sm bg-gradient-to-br from-purple-500 to-purple-600">
                  <CardHeader className="pb-2">
                    <p className="text-purple-100 text-sm font-medium">System GMV (All-time) <InfoTooltip term="GMV" /></p>
                    <CardTitle className="text-3xl font-bold text-white tracking-tighter">₹{metrics.gmv.toLocaleString()}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-purple-100 text-xs">{appointments.length} Consultations processed</div>
                  </CardContent>
                  <Building2 className="absolute -right-2 -bottom-2 h-24 w-24 text-white/10" />
                </Card>

                <Card className="relative overflow-hidden group hover:shadow-lg transition-all border-none shadow-sm bg-gradient-to-br from-orange-500 to-orange-600">
                  <CardHeader className="pb-2">
                    <p className="text-orange-100 text-sm font-medium">Patient Reach <InfoTooltip term="Patient Reach" /></p>
                    <CardTitle className="text-3xl font-bold text-white tracking-tighter">{metrics.totalPatients.toLocaleString()}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-orange-100 text-xs">Unique patients in ecosystem</div>
                  </CardContent>
                  <Users className="absolute -right-2 -bottom-2 h-24 w-24 text-white/10" />
                </Card>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Revenue Breakdown */}
                <Card className="shadow-sm">
                  <CardHeader>
                    <CardTitle>Revenue Breakdown</CardTitle>
                    <CardDescription>Contribution of mixed revenue streams to MRR</CardDescription>
                  </CardHeader>
                  <CardContent className="h-[300px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={metrics.breakdown}
                          cx="50%"
                          cy="50%"
                          innerRadius={60}
                          outerRadius={100}
                          paddingAngle={5}
                          dataKey="value"
                        >
                          {metrics.breakdown.map((entry: any, index: number) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(value: number) => `₹${value.toLocaleString()}`} />
                        <Legend verticalAlign="bottom" height={36} />
                      </PieChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                {/* Scale Projections Chart */}
                <Card className="shadow-sm">
                  <CardHeader>
                    <CardTitle>Growth Scenarios (Annual MRR Forecast)</CardTitle>
                    <CardDescription>Simulated projection for next 12 months</CardDescription>
                  </CardHeader>
                  <CardContent className="h-[300px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart
                        data={[
                          { name: 'Month 0', cons: metrics.mrr, real: metrics.mrr, opt: metrics.mrr },
                          { name: 'Month 3', cons: metrics.mrr * 2, real: metrics.mrr * 3, opt: metrics.mrr * 4 },
                          { name: 'Month 6', cons: metrics.mrr * 4, real: metrics.mrr * 8, opt: metrics.mrr * 12 },
                          { name: 'Month 9', cons: metrics.mrr * 6, real: metrics.mrr * 15, opt: metrics.mrr * 25 },
                          { name: 'Month 12', cons: metrics.mrr * 10, real: metrics.mrr * 30, opt: metrics.mrr * 60 },
                        ]}
                      >
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="name" />
                        <YAxis />
                        <Tooltip formatter={(value: number) => `₹${value.toLocaleString()}`} />
                        <Area type="monotone" dataKey="opt" stroke="#a855f7" fill="#a855f7" fillOpacity={0.1} name="Optimistic" />
                        <Area type="monotone" dataKey="real" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.2} name="Realistic" />
                        <Area type="monotone" dataKey="cons" stroke="#94a3b8" fill="#94a3b8" fillOpacity={0.1} name="Conservative" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {activeTab === 'cohorts' && (
            <div className="space-y-8 animate-in slide-in-from-bottom-4 transition-all duration-500">
              <Card>
                <CardHeader>
                  <CardTitle>Clinic Retention Cohorts</CardTitle>
                  <CardDescription>Percentage of clinics remaining active month-over-month</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto rounded-lg border">
                    <Table>
                      <TableHeader className="bg-muted/50">
                        <TableRow>
                          <TableHead className="w-[120px]">Cohort</TableHead>
                          <TableHead className="text-center">Size</TableHead>
                          <TableHead className="text-center">Month 1</TableHead>
                          <TableHead className="text-center">Month 2</TableHead>
                          <TableHead className="text-center">Month 3</TableHead>
                          <TableHead className="text-center">Month 4</TableHead>
                          <TableHead className="text-center">Month 5</TableHead>
                          <TableHead className="text-center">Month 6</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {cohortData.map((row) => (
                          <TableRow key={row.month}>
                            <TableCell className="font-medium">{row.month}</TableCell>
                            <TableCell className="text-center font-bold text-blue-600">{row.size}</TableCell>
                            <TableCell className={`text-center ${row.m1 ? (row.m1 >= 90 ? 'bg-green-100 text-green-800' : 'bg-green-50 text-green-600') : ''}`}>{row.m1 ? `${row.m1}%` : '-'}</TableCell>
                            <TableCell className={`text-center ${row.m2 ? (row.m2 >= 90 ? 'bg-green-100 text-green-800' : 'bg-green-50 text-green-600') : ''}`}>{row.m2 ? `${row.m2}%` : '-'}</TableCell>
                            <TableCell className={`text-center ${row.m3 ? (row.m3 >= 90 ? 'bg-green-100 text-green-800' : 'bg-green-50 text-green-600') : ''}`}>{row.m3 ? `${row.m3}%` : '-'}</TableCell>
                            <TableCell className={`text-center ${row.m4 ? (row.m4 >= 90 ? 'bg-green-100 text-green-800' : 'bg-green-50 text-green-600') : ''}`}>{row.m4 ? `${row.m4}%` : '-'}</TableCell>
                            <TableCell className={`text-center ${row.m5 ? (row.m5 >= 90 ? 'bg-green-100 text-green-800' : 'bg-green-50 text-green-600') : ''}`}>{row.m5 ? `${row.m5}%` : '-'}</TableCell>
                            <TableCell className={`text-center ${row.m6 ? (row.m6 >= 90 ? 'bg-green-100 text-green-800' : 'bg-green-50 text-green-600') : ''}`}>{row.m6 ? `${row.m6}%` : '-'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {activeTab === 'seed' && (
            <div className="space-y-8 animate-in fade-in transition-all duration-500">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* 1. Early Traction Scenario */}
                <Card className="border-none shadow-lg bg-white">
                  <CardHeader className="bg-slate-50 rounded-t-xl border-b pb-4">
                    <CardTitle className="flex items-center gap-2">
                      <ArrowUpRight className="h-5 w-5 text-emerald-600" />
                      Early Traction Modeler
                    </CardTitle>
                    <CardDescription>Simulate your first 6 months of clinic adoption.</CardDescription>
                  </CardHeader>
                  <CardContent className="pt-6 space-y-6">
                    <div className="grid grid-cols-2 gap-6">
                      <div className="space-y-2">
                        <label className="text-xs font-semibold uppercase text-slate-500">Paying Clinics</label>
                        <div className="flex items-end gap-2">
                          <span className="text-3xl font-bold text-slate-900">{seedScenario.paying}</span>
                          <span className="text-sm text-slate-500 mb-1">clinics</span>
                        </div>
                        <input type="range" min="0" max="20" value={seedScenario.paying} onChange={e => setSeedScenario({ ...seedScenario, paying: Number(e.target.value) })} className="w-full h-2 bg-emerald-100 rounded-lg appearance-none cursor-pointer accent-emerald-500" />
                        <p className="text-[10px] text-emerald-600 font-medium">Validation: High (Rev Generated)</p>
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-semibold uppercase text-slate-500">Beta/Testing</label>
                        <div className="flex items-end gap-2">
                          <span className="text-3xl font-bold text-slate-900">{seedScenario.testing}</span>
                          <span className="text-sm text-slate-500 mb-1">clinics</span>
                        </div>
                        <input type="range" min="0" max="50" value={seedScenario.testing} onChange={e => setSeedScenario({ ...seedScenario, testing: Number(e.target.value) })} className="w-full h-2 bg-blue-100 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                        <p className="text-[10px] text-blue-600 font-medium">Validation: Medium (Feedback)</p>
                      </div>
                    </div>
                    <div className="space-y-2 pt-2 border-t">
                      <div className="flex justify-between items-center">
                        <label className="text-xs font-semibold uppercase text-slate-500">Pilot Price (₹ / Mo)</label>
                        <span className="text-sm font-bold">₹{seedScenario.pilotPrice}</span>
                      </div>
                      <input type="range" min="0" max="5000" step="100" value={seedScenario.pilotPrice} onChange={e => setSeedScenario({ ...seedScenario, pilotPrice: Number(e.target.value) })} className="w-full h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-slate-900" />
                    </div>

                    <div className="rounded-lg bg-slate-50 p-4 space-y-2">
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-slate-600">Current MRR (Traction):</span>
                        <span className="font-bold text-emerald-600">₹{((seedScenario.paying * seedScenario.pilotPrice) + (seedScenario.paying * 45 * 25 * 0.5)).toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-slate-600">Potential MRR (Beta Convert):</span>
                        <span className="font-bold text-blue-600">₹{((seedScenario.testing * pricing.subscription)).toLocaleString()}</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* 2. Valuation Calculator */}
                <Card className="border-none shadow-lg bg-slate-900 text-white">
                  <CardHeader className="border-b border-slate-800 pb-4">
                    <CardTitle className="flex items-center gap-2">
                      <Target className="h-5 w-5 text-purple-400" />
                      Seed Valuation Calculator
                    </CardTitle>
                    <CardDescription className="text-slate-400">Ask Amount vs Equity Dilution</CardDescription>
                  </CardHeader>
                  <CardContent className="pt-6 space-y-6">
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <label className="text-xs font-semibold uppercase text-slate-500">Ask Amount (₹)</label>
                        <div className="text-3xl font-bold">₹{(seedFundraising.askAmount / 100000).toFixed(1)} Lakhs</div>
                        <input type="range" min="1000000" max="25000000" step="500000" value={seedFundraising.askAmount} onChange={e => setSeedFundraising({ ...seedFundraising, askAmount: Number(e.target.value) })} className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-purple-500" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-semibold uppercase text-slate-500">Equity Offered (%)</label>
                        <div className="text-3xl font-bold text-purple-400">{seedFundraising.equityOffered}%</div>
                        <input type="range" min="1" max="30" step="0.5" value={seedFundraising.equityOffered} onChange={e => setSeedFundraising({ ...seedFundraising, equityOffered: Number(e.target.value) })} className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-purple-500" />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-800">
                      <div>
                        <div className="text-xs text-slate-500 uppercase mb-1">Post-Money Valuation</div>
                        <div className="text-xl font-bold text-white">₹{((seedFundraising.askAmount / seedFundraising.equityOffered) * 100 / 10000000).toFixed(2)} Cr</div>
                        <p className="text-[10px] text-slate-500 mt-1">Total value after investment</p>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 uppercase mb-1">Pre-Money Valuation</div>
                        <div className="text-xl font-bold text-slate-300">₹{(((seedFundraising.askAmount / seedFundraising.equityOffered) * 100 - seedFundraising.askAmount) / 10000000).toFixed(2)} Cr</div>
                        <p className="text-[10px] text-slate-500 mt-1">Value of your company today</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* 3. Investor Educational Content */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <Card className="bg-gradient-to-br from-indigo-50 to-white border-indigo-100">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base text-indigo-700">What is "Traction"?</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-slate-600 space-y-2">
                    <p><strong className="text-slate-900">Proof of Need &gt; Revenue.</strong> For Seed stage, investors want to see that users LOVED the product.</p>
                    <ul className="list-disc pl-4 space-y-1 text-xs">
                      <li>5 Paying Clinics is better than 50 Free ones.</li>
                      <li>Retention is key. Do they use it daily?</li>
                      <li>Are they referring other doctors?</li>
                    </ul>
                  </CardContent>
                </Card>

                <Card className="bg-gradient-to-br from-amber-50 to-white border-amber-100">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base text-amber-700">Investor Cheatsheet</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-slate-600 space-y-2">
                    <p><strong className="text-slate-900">Impress them with Velocity.</strong></p>
                    <ul className="list-disc pl-4 space-y-1 text-xs">
                      <li>"We got 5 clinics in 4 weeks." (Speed)</li>
                      <li>"30% of patients accepted digital prescriptions." (Adoption)</li>
                      <li>"We know our CAC is ₹5k." (Data-driven)</li>
                    </ul>
                  </CardContent>
                </Card>

                <Card className="bg-gradient-to-br from-emerald-50 to-white border-emerald-100">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base text-emerald-700">Fundraising Targets</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-slate-600 space-y-2">
                    <p><strong className="text-slate-900">Sweet Spot for Seed:</strong></p>
                    <ul className="list-disc pl-4 space-y-1 text-xs">
                      <li><strong>Ask:</strong> ₹50L - ₹2Cr</li>
                      <li><strong>Dilution:</strong> 10-20% Equity</li>
                      <li><strong>Runway:</strong> Aim for 12-18 months.</li>
                      <li><strong>Milestone:</strong> Get to ₹10L ARR or 50 Clinics.</li>
                    </ul>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {activeTab === 'playbook' && (
            <div className="space-y-8 animate-in fade-in transition-all duration-500">
              <div className="grid grid-cols-1 gap-8">
                {/* SaaS Efficiency Metrics & P&L */}
                <div className="space-y-6">
                  {/* SaaS Efficiency Metrics */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Card className="bg-slate-50 border-blue-100">
                      <CardHeader className="p-4">
                        <CardTitle className="text-sm text-muted-foreground flex items-center">LTV / CAC Ratio <InfoTooltip term="LTV" /><InfoTooltip term="CAC" /></CardTitle>
                        <div className="text-2xl font-bold text-blue-600">{pnlProjections.efficiency.ltvCac.toFixed(1)}x</div>
                        <CardDescription className="text-[10px]">Investor Target: &gt; 3.0x</CardDescription>
                      </CardHeader>
                    </Card>
                    <Card className="bg-slate-50 border-emerald-100">
                      <CardHeader className="p-4">
                        <CardTitle className="text-sm text-muted-foreground flex items-center">Payback Period <InfoTooltip term="Payback Period" /></CardTitle>
                        <div className="text-2xl font-bold text-emerald-600">{pnlProjections.efficiency.payback.toFixed(1)} Months</div>
                        <CardDescription className="text-[10px]">Investor Target: &lt; 12 mo</CardDescription>
                      </CardHeader>
                    </Card>
                    <Card className="bg-slate-50 border-purple-100">
                      <CardHeader className="p-4">
                        <CardTitle className="text-sm text-muted-foreground">Proj. Gross Margin</CardTitle>
                        <div className="text-2xl font-bold text-purple-600">
                          {Math.round(pnlProjections.projection[pnlProjections.projection.length - 1].margin)}%
                        </div>
                        <CardDescription className="text-[10px]">At 12-Month Scale</CardDescription>
                      </CardHeader>
                    </Card>
                  </div>

                  <Card className="bg-slate-900 text-white overflow-hidden relative border-none shadow-lg">
                    <CardHeader>
                      <CardTitle className="text-white flex items-center gap-2">
                        <Shield className="h-5 w-5 text-blue-400" />
                        Unit Economics (Per Clinic / Month) <InfoTooltip term="Contribution Margin" />
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-4">
                        <div className="flex justify-between border-b border-slate-700 pb-2">
                          <span className="text-slate-400">Monthly Revenue (Sub + Avg Tokens)</span>
                          <span className="font-bold">₹{(pricing.subscription + (45 * 25 * pricing.tokenFee)).toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between border-b border-slate-700 pb-2 text-red-400 text-sm">
                          <span>Variable Costs (SMS + Cloud)</span>
                          <span>- ₹{((45 * 25 * assumptions.smsCost) + 100).toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between pt-2">
                          <span className="font-bold underline">Contribution Margin</span>
                          <span className="text-xl font-black text-blue-400">
                            ₹{((pricing.subscription + (45 * 25 * pricing.tokenFee)) - ((45 * 25 * assumptions.smsCost) + 100)).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-500 italic mt-2">
                          *Excludes CAC and fixed head-count. This is the "Product Profitability" per clinic.
                        </p>
                      </div>
                    </CardContent>
                    <DollarSign className="absolute -right-4 -bottom-4 h-24 w-24 text-white/5" />
                  </Card>

                  <Card className="border-none shadow-sm">
                    <CardHeader>
                      <CardTitle>12-Month P&L & Burn Projection</CardTitle>
                      <CardDescription>Automatic forecast based on current {metrics.activeClinics} clinics & global assumptions</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="overflow-x-auto rounded-xl border border-slate-100">
                        <Table>
                          <TableHeader className="bg-slate-50">
                            <TableRow>
                              <TableHead className="font-bold">Month</TableHead>
                              <TableHead className="text-right font-bold">Clinics</TableHead>
                              <TableHead className="text-right font-bold text-blue-600">Revenue</TableHead>
                              <TableHead className="text-right font-bold text-red-600">Burn (OpEx) <InfoTooltip term="Burn" /></TableHead>
                              <TableHead className="text-right font-bold">Net Profit</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {pnlProjections.projection.map((row: any) => (
                              <TableRow key={row.month} className={row.profit < 0 ? 'hover:bg-red-50/10' : 'hover:bg-green-50/10'}>
                                <TableCell className="font-medium">{row.month}</TableCell>
                                <TableCell className="text-right">{row.clinics}</TableCell>
                                <TableCell className="text-right font-semibold">₹{Math.round(row.revenue).toLocaleString()}</TableCell>
                                <TableCell className="text-right text-red-600">₹{Math.round(row.opex).toLocaleString()}</TableCell>
                                <TableCell className={`text-right font-bold ${row.profit >= 0 ? 'text-green-600' : 'text-red-700'}`}>
                                  ₹{Math.round(row.profit).toLocaleString()}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'market' && (
            <div className="space-y-8 animate-in fade-in transition-all duration-500">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Market Opportunity Slice */}
                <Card>
                  <CardHeader>
                    <CardTitle>Market Capture Potential (India TAM/SAM)</CardTitle>
                    <CardDescription>TAM: ₹{(pnlProjections.market.tam / 10000000).toFixed(1)} Cr | SAM: ₹{(pnlProjections.market.sam / 10000000).toFixed(1)} Cr</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="pt-2 space-y-4">
                      <div className="p-4 bg-slate-50 rounded-xl">
                        <p className="text-xs text-slate-500 uppercase font-bold mb-1 flex items-center">Total India TAM <InfoTooltip term="TAM" /></p>
                        <p className="text-2xl font-black">₹{(pnlProjections.market.tam / 10000000).toFixed(1)} Cr <span className="text-xs font-normal">/ year</span></p>
                      </div>
                      <div className="p-4 bg-blue-50 rounded-xl border border-blue-100">
                        <p className="text-xs text-blue-500 uppercase font-bold mb-1 flex items-center">Serviceable (SAM) <InfoTooltip term="SAM" /></p>
                        <p className="text-2xl font-black text-blue-700">₹{(pnlProjections.market.sam / 10000000).toFixed(1)} Cr <span className="text-xs font-normal">/ year</span></p>
                      </div>
                      <div className="p-4 bg-emerald-50 rounded-xl border border-emerald-100">
                        <p className="text-xs text-emerald-500 uppercase font-bold mb-1 flex items-center">Target Slice (SOM - 12mo) <InfoTooltip term="SOM" /></p>
                        <p className="text-2xl font-black text-emerald-700">₹{(pnlProjections.market.som / 10000000).toFixed(1)} Cr <span className="text-xs font-normal">/ year</span></p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Series A Funds & Health */}
                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <Card className="bg-slate-900 text-white border-none overflow-hidden relative">
                      <CardHeader>
                        <CardTitle className="text-white flex items-center gap-2">
                          <Target className="h-5 w-5 text-blue-400" />
                          Series A: Product/Scale Split
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="space-y-4">
                          {Object.entries(useOfFunds).map(([key, value]) => (
                            <div key={key} className="space-y-1">
                              <div className="flex justify-between text-[10px] uppercase font-bold text-slate-500">
                                <span>{key}</span>
                                <span className="text-blue-400">{value}%</span>
                              </div>
                              <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                                <div className="bg-blue-500 h-full" style={{ width: `${value}%` }} />
                              </div>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardTitle className="text-sm">SaaS Efficiency Score</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="text-center py-4">
                          <p className="text-xs text-slate-500 uppercase font-bold mb-1">Rule of 40 Score <InfoTooltip term="Rule of 40" /></p>
                          <p className={`text-4xl font-black ${pnlProjections.ruleOf40 > 40 ? 'text-emerald-600' : 'text-orange-600'}`}>
                            {Math.round(pnlProjections.ruleOf40)}%
                          </p>
                          <Badge variant={pnlProjections.ruleOf40 > 40 ? 'default' : 'secondary'} className="mt-2">
                            {pnlProjections.ruleOf40 > 40 ? 'Venture Grade' : 'Needs Growth/Scale'}
                          </Badge>
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  <Card className="bg-gradient-to-r from-blue-600 to-indigo-700 text-white border-none shadow-xl">
                    <CardHeader>
                      <CardTitle className="text-white">Investment Thesis</CardTitle>
                    </CardHeader>
                    <CardContent className="grid grid-cols-2 gap-4 text-xs">
                      <div className="space-y-1">
                        <h4 className="font-bold text-blue-200">Defensibility</h4>
                        <p>High switching costs via clinic deep-integration.</p>
                      </div>
                      <div className="space-y-1">
                        <h4 className="font-bold text-blue-200">Profitability</h4>
                        <p>85%+ contribution margin per node.</p>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'planning' && (
            <div className="space-y-8 animate-in fade-in zoom-in-95 transition-all duration-500">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Hiring Roadmap */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Users className="h-5 w-5" />
                      Hiring & Roadmap
                    </CardTitle>
                    <CardDescription>Scale headcount with clinic growth</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-6 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-slate-300 before:to-transparent">
                      {hiringPlan.map((step, i) => (
                        <div key={i} className="relative flex items-center justify-between md:justify-start md:odd:flex-row-reverse group select-none">
                          <div className="flex items-center justify-center w-8 h-8 rounded-full border border-white bg-slate-100 shadow shrink-0 z-10">
                            <step.icon className="h-4 w-4 text-slate-500" />
                          </div>
                          <div className="w-[calc(100%-3rem)] md:w-[calc(50%-2rem)] p-3 rounded border bg-white shadow-sm hover:border-blue-400 transition-all">
                            <div className="flex items-center justify-between mb-1">
                              <div className="font-bold text-slate-900 text-sm">{step.role}</div>
                              <time className="font-medium text-blue-500 text-[10px] uppercase">{step.time}</time>
                            </div>
                            <div className="text-slate-500 text-xs">Status: <Badge variant={step.status === 'Active' ? 'default' : 'secondary'} className="text-[10px] uppercase h-4 px-1">{step.status}</Badge></div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                {/* Valuation Calculator */}
                <Card className="bg-slate-900 text-white border-none overflow-hidden relative">
                  <CardHeader>
                    <div className="flex justify-between items-start">
                      <div>
                        <CardTitle className="text-white flex items-center gap-2">
                          <Target className="h-5 w-5 text-blue-400" />
                          Valuation Projection
                        </CardTitle>
                        <CardDescription className="text-slate-400 text-xs text-balance">Series A Revenue Multiple Simulation</CardDescription>
                      </div>
                      <div className="flex bg-slate-800 rounded-lg p-1 text-[10px]">
                        <button
                          onClick={() => { setValuationMarket('Global'); setMrrMultiple(8); }}
                          className={`px-2 py-1 rounded ${valuationMarket === 'Global' ? 'bg-blue-600 text-white' : 'text-slate-400'}`}
                        >
                          Global
                        </button>
                        <button
                          onClick={() => { setValuationMarket('India'); setMrrMultiple(12); }}
                          className={`px-2 py-1 rounded ${valuationMarket === 'India' ? 'bg-blue-600 text-white' : 'text-slate-400'}`}
                        >
                          India
                        </button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-8">
                    <div className="space-y-4">
                      <div className="flex justify-between items-center">
                        <label className="text-sm font-medium">Multiple ({valuationMarket})</label>
                        <span className="text-blue-400 font-bold text-xl">{mrrMultiple}x</span>
                      </div>
                      <input
                        type="range"
                        min={valuationMarket === 'India' ? 8 : 5}
                        max={valuationMarket === 'India' ? 25 : 20}
                        step="1"
                        value={mrrMultiple}
                        onChange={(e) => setMrrMultiple(parseInt(e.target.value))}
                        className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="p-4 rounded-xl bg-slate-800/50 border border-slate-700 text-center">
                        <p className="text-slate-400 text-[10px] uppercase tracking-wider mb-1">Current Val.</p>
                        <p className="text-xl font-black text-blue-400">₹{(metrics.arr * mrrMultiple / 10000000).toFixed(1)} Cr</p>
                      </div>
                      <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 text-center">
                        <p className="text-blue-300 text-[10px] uppercase tracking-wider mb-1 underline">12Mo Target</p>
                        <p className="text-xl font-black text-white">₹{(metrics.arr * 10 * mrrMultiple / 10000000).toFixed(1)} Cr</p>
                      </div>
                    </div>

                    <div className="p-6 border border-slate-800 rounded-xl bg-slate-800/30">
                      <p className="text-white font-bold mb-4 flex items-center gap-2 text-sm">
                        <PieChartIcon className="h-4 w-4" />
                        Valuation Logic ({valuationMarket})
                      </p>
                      <ul className="space-y-3 text-[10px] text-slate-400">
                        <li className="flex items-start gap-2">
                          <div className="h-1.5 w-1.5 rounded-full bg-blue-500 mt-1 shrink-0" />
                          {valuationMarket === 'India'
                            ? "Indian HealthTech commands a 'Growth Premium'."
                            : "Global SaaS valuation focuses on efficient LTV/CAC."}
                        </li>
                        <li className="flex items-start gap-2">
                          <div className="h-1.5 w-1.5 rounded-full bg-blue-500 mt-1 shrink-0" />
                          Multiple scales with high NRR (110%+)
                        </li>
                      </ul>
                    </div>
                  </CardContent>
                  <TrendingUp className="absolute right-[-10%] bottom-[-10%] h-64 w-64 text-slate-800/50 pointer-events-none" />
                </Card>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
