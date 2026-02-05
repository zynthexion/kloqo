'use client';

import React from 'react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Check, Zap, Smartphone, MessageSquare, AlertCircle, Crown, Box, Wallet, Users, Gift } from 'lucide-react';

const SaaSPlansPage = () => {
    return (
        <div className="space-y-16 pb-10">
            {/* Header Section */}
            <div className="text-center md:text-left space-y-2">
                <h1 className="text-3xl font-extrabold tracking-tight text-gray-900">Simple Annual Pricing</h1>
                <p className="text-lg text-gray-600 max-w-3xl">
                    One payment, one year of peace. All annual plans include <strong className="text-gray-900">Unlimited Patients</strong>.
                    <br />Need flexibility? Check out our <span className="text-green-600 font-bold">Flexi Packs</span> below.
                </p>
            </div>

            {/* SECTION 1: ANNUAL PLANS */}
            <div>
                <h2 className="text-xl font-bold text-gray-900 mb-6 flex items-center gap-2">
                    <Zap className="h-5 w-5 text-yellow-500 fill-yellow-500" />
                    Annual Subscriptions
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8 items-start">

                    {/* TIER 1: STARTER */}
                    <Card className="flex flex-col border-2 border-gray-100 hover:border-gray-300 transition-all duration-300 shadow-sm hover:shadow-md h-full">
                        <CardHeader>
                            <div className="flex justify-between items-start">
                                <CardTitle className="text-xl font-bold text-gray-700">Starter</CardTitle>
                                <Badge variant="secondary" className="bg-gray-100 text-gray-600">Software Only</Badge>
                            </div>
                            <div className="mt-4">
                                <span className="text-4xl font-extrabold text-gray-900">₹11,999</span>
                                <span className="text-gray-500 font-medium">/year</span>
                            </div>
                            <p className="text-xs text-green-600 font-bold uppercase tracking-wide bg-green-50 inline-block px-2 py-1 rounded mt-2">
                                Effective: ₹999/mo
                            </p>
                            <CardDescription className="pt-3">
                                Essential record-keeping for clinics with existing hardware.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="flex-1 space-y-4">
                            {/* BONUS BOX */}
                            <div className="p-3 bg-amber-50 rounded-lg border border-amber-100">
                                <div className="flex items-center gap-2 font-bold text-amber-700 mb-1 text-xs uppercase tracking-wide">
                                    <Gift className="h-4 w-4" />
                                    Initial Purchase Bonus
                                </div>
                                <p className="text-xs text-gray-600 leading-snug">
                                    <strong>FREE WhatsApp Mini Pack</strong> (Worth ₹500). Includes 2,000 messages to get you started!
                                </p>
                            </div>

                            <ul className="space-y-3 shrink-0">
                                <PlanFeature text="Unlimited Appointments" bold />
                                <PlanFeature text="Receptionist Dashboard Only" icon={<Smartphone className="h-3.5 w-3.5 text-gray-500" />} />
                                <PlanFeature text="Pay-as-you-go WhatsApp" icon={<AlertCircle className="h-3.5 w-3.5 text-amber-500" />} />
                                <PlanFeature text="Basic Daily Analytics" />
                            </ul>
                        </CardContent>
                        <CardFooter>
                            <Button variant="outline" className="w-full font-semibold">Select Starter</Button>
                        </CardFooter>
                    </Card>

                    {/* TIER 2: GROWTH */}
                    <Card className="flex flex-col border-2 border-blue-100 hover:border-blue-300 bg-blue-50/30 transition-all duration-300 shadow-md h-full relative">
                        <div className="absolute top-0 right-0 bg-blue-600 text-white px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded-bl-lg">
                            Most Popular
                        </div>
                        <CardHeader>
                            <div className="flex justify-between items-start">
                                <CardTitle className="text-xl font-bold text-blue-700 flex items-center gap-2">
                                    <Users className="h-5 w-5" />
                                    Growth
                                </CardTitle>
                            </div>
                            <div className="mt-4">
                                <span className="text-4xl font-extrabold text-gray-900">₹17,999</span>
                                <span className="text-gray-500 font-medium">/year</span>
                            </div>
                            <p className="text-xs text-blue-600 font-bold uppercase tracking-wide bg-blue-100 inline-block px-2 py-1 rounded mt-2">
                                Effective: ₹1,499/mo
                            </p>
                            <CardDescription className="pt-3">
                                Enhanced operational tools with multi-login support.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="flex-1 space-y-5">
                            {/* STICK BOX */}
                            <div className="p-3 bg-white rounded-lg border border-blue-200 shadow-sm">
                                <div className="flex items-center gap-2 font-bold text-blue-800 mb-1 text-xs uppercase tracking-wider">
                                    <Box className="h-3.5 w-3.5" />
                                    Included Hardware
                                </div>
                                <div className="text-xs flex items-center gap-2 font-medium text-gray-700">
                                    <Check className="h-3 w-3 text-green-500" /> FREE Kloqo Smart Stick (Fire TV)
                                </div>
                            </div>

                            <ul className="space-y-3 shrink-0">
                                <PlanFeature text="Unlimited Appointments" bold />
                                <PlanFeature text="1,000 FREE WhatsApp Credits/mo" bold highlighted icon={<MessageSquare className="h-3.5 w-3.5 text-green-600" />} />
                                <PlanFeature text="Doctor + Receptionist Login" />
                                <PlanFeature text="Staff Performance Logs" />
                                <PlanFeature text="Advanced Analytics Dashboard" />
                            </ul>
                        </CardContent>
                        <CardFooter>
                            <Button className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold shadow-lg shadow-blue-200">
                                Select Growth
                            </Button>
                        </CardFooter>
                    </Card>

                    {/* TIER 3: PRO BUNDLE (Hardware) */}
                    <Card className="flex flex-col relative overflow-hidden border-2 border-primary shadow-2xl scale-105 z-10 h-full">
                        <div className="absolute top-0 inset-x-0 bg-primary h-1.5" />
                        <CardHeader className="bg-primary/5 pb-8">
                            <CardTitle className="text-2xl font-bold flex items-center gap-2 text-primary">
                                <Crown className="h-6 w-6 fill-primary" />
                                Pro Bundle
                            </CardTitle>
                            <div className="mt-4">
                                <span className="text-5xl font-extrabold text-gray-900">₹24,999</span>
                                <span className="text-gray-500 font-medium">/year</span>
                            </div>
                            <p className="text-xs text-primary font-bold uppercase tracking-wide bg-primary/10 inline-block px-2 py-1 rounded mt-2">
                                Effective: ₹2,083/mo
                            </p>
                            <CardDescription className="pt-2 text-gray-600">
                                The complete "Plug & Play" tablet system.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="flex-1 space-y-5 pt-6">
                            {/* HARDWARE BOX */}
                            <div className="p-3 bg-gray-900 text-white rounded-lg border border-gray-800 shadow-inner">
                                <div className="flex items-center gap-2 font-bold text-yellow-400 mb-2 text-xs uppercase tracking-wider">
                                    <Box className="h-4 w-4" />
                                    Full Hardware Kit (Worth ₹15,500)
                                </div>
                                <ul className="space-y-1.5">
                                    <li className="text-xs flex items-center gap-2">
                                        <Check className="h-3 w-3 text-green-400" /> Samsung Galaxy Tab A9
                                    </li>
                                    <li className="text-xs flex items-center gap-2">
                                        <Check className="h-3 w-3 text-green-400" /> Metal Desktop Stand
                                    </li>
                                    <li className="text-xs flex items-center gap-2 font-bold text-white">
                                        <Check className="h-3 w-3 text-green-400" /> FREE Kloqo Smart Stick
                                    </li>
                                </ul>
                            </div>

                            <ul className="space-y-3 shrink-0">
                                <PlanFeature text="Everything in Growth Plan" bold />
                                <PlanFeature text="2,000 FREE WhatsApp Credits/mo" bold highlighted icon={<MessageSquare className="h-3.5 w-3.5 text-primary" />} />
                                <PlanFeature text="Zipper Algorithm (Online/Offline)" highlighted />
                                <PlanFeature text="Priority 24/7 Support" />
                            </ul>
                        </CardContent>
                        <CardFooter className="bg-primary/5 pt-6">
                            <Button className="w-full bg-primary hover:bg-primary/90 shadow-lg shadow-primary/20 h-11 text-md font-bold">
                                Get Pro Bundle
                            </Button>
                        </CardFooter>
                    </Card>
                </div>
            </div>

            {/* SECTION 2: FLEXI PACKS */}
            <div className="pt-10 border-t border-gray-200">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
                    <div>
                        <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                            <Wallet className="h-6 w-6 text-green-600" />
                            Flexi Packs <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded-full uppercase tracking-wide">Pay-Per-Patient</span>
                        </h2>
                        <p className="text-gray-500 mt-1">
                            Can't commit to a year? Buy credits that never expire.
                        </p>
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                    {/* Flexi 1 */}
                    <Card className="border-gray-200 hover:border-green-400 hover:shadow-md transition-all">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-lg font-bold text-gray-600">Starter Pack</CardTitle>
                            <div className="text-3xl font-extrabold text-gray-900 mt-2">₹499</div>
                        </CardHeader>
                        <CardContent>
                            <div className="text-lg font-bold text-green-600 mb-1">300 Patient Credits</div>
                            <div className="mt-4 pt-4 border-t border-gray-100 flex justify-between items-center text-sm">
                                <span className="text-gray-500">Cost per patient</span>
                                <span className="font-bold bg-gray-100 px-2 py-1 rounded">₹1.66</span>
                            </div>
                        </CardContent>
                        <CardFooter>
                            <Button variant="outline" className="w-full border-green-200 text-green-700 hover:bg-green-50">Buy Pack</Button>
                        </CardFooter>
                    </Card>

                    {/* Flexi 2 */}
                    <Card className="border-green-200 bg-green-50/30 hover:shadow-md transition-all relative">
                        <div className="absolute top-0 right-0 bg-green-600 text-white px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded-bl-lg">
                            Popular
                        </div>
                        <CardHeader className="pb-2">
                            <CardTitle className="text-lg font-bold text-gray-600">Value Pack</CardTitle>
                            <div className="text-3xl font-extrabold text-gray-900 mt-2">₹1,499</div>
                        </CardHeader>
                        <CardContent>
                            <div className="text-lg font-bold text-green-600 mb-1">1,000 Patient Credits</div>
                            <div className="mt-4 pt-4 border-t border-gray-100 flex justify-between items-center text-sm">
                                <span className="text-gray-500">Cost per patient</span>
                                <span className="font-bold bg-green-100 text-green-800 px-2 py-1 rounded">₹1.50</span>
                            </div>
                        </CardContent>
                        <CardFooter>
                            <Button className="w-full bg-green-600 hover:bg-green-700">Buy Pack</Button>
                        </CardFooter>
                    </Card>

                    {/* Flexi 3 */}
                    <Card className="border-gray-200 hover:border-green-400 hover:shadow-md transition-all">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-lg font-bold text-gray-600">Jumbo Pack</CardTitle>
                            <div className="text-3xl font-extrabold text-gray-900 mt-2">₹2,999</div>
                        </CardHeader>
                        <CardContent>
                            <div className="text-lg font-bold text-green-600 mb-1">2,500 Patient Credits</div>
                            <div className="mt-4 pt-4 border-t border-gray-100 flex justify-between items-center text-sm">
                                <span className="text-gray-500">Cost per patient</span>
                                <span className="font-bold bg-gray-100 px-2 py-1 rounded">₹1.20</span>
                            </div>
                        </CardContent>
                        <CardFooter>
                            <Button variant="outline" className="w-full border-green-200 text-green-700 hover:bg-green-50">Buy Pack</Button>
                        </CardFooter>
                    </Card>
                </div>
                <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200 text-xs text-gray-500 flex gap-2 items-start">
                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <p><strong>Note:</strong> Flexi plans are "Software Only". Hardware must be purchased separately or clinics can use their own devices.</p>
                </div>
            </div>

            {/* SECTION 3: WHATSAPP ADD-ONS */}
            <div className="pt-10 border-t border-gray-200">
                <div className="flex items-center gap-3 mb-6">
                    <div className="p-2 bg-green-50 rounded-lg">
                        <MessageSquare className="h-6 w-6 text-green-600" />
                    </div>
                    <div>
                        <h2 className="text-2xl font-bold text-gray-900">WhatsApp Packs</h2>
                        <p className="text-sm text-gray-500">
                            Required for Flexi & Starter. Included in Growth (1000) & Pro (2000).
                        </p>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl">
                    <div className="flex items-center justify-between p-5 border rounded-xl bg-white hover:border-gray-300 transition-all">
                        <div>
                            <div className="text-sm font-bold text-gray-500 uppercase">Mini Pack</div>
                            <div className="text-2xl font-extrabold text-gray-900">₹500</div>
                            <div className="text-xs text-gray-400 mt-1">2,000 Messages (₹0.25/msg)</div>
                        </div>
                        <Button variant="outline" size="sm">Add</Button>
                    </div>
                    <div className="flex items-center justify-between p-5 border border-green-200 bg-green-50/20 rounded-xl hover:shadow-sm transition-all">
                        <div>
                            <div className="text-sm font-bold text-green-700 uppercase flex items-center gap-2">
                                Mega Pack <Badge className="bg-green-600 text-[10px] h-4">Best</Badge>
                            </div>
                            <div className="text-2xl font-extrabold text-gray-900">₹2,000</div>
                            <div className="text-xs text-gray-500 mt-1">10,000 Messages (₹0.20/msg)</div>
                        </div>
                        <Button className="bg-green-600 hover:bg-green-700">Add</Button>
                    </div>
                </div>
            </div>
        </div>
    );
};

// --- Helper Components ---

const PlanFeature = ({ text, bold = false, highlighted = false, dimmed = false, icon }: { text: string, bold?: boolean, highlighted?: boolean, dimmed?: boolean, icon?: React.ReactNode }) => (
    <li className={`flex items-start gap-3 ${dimmed ? 'opacity-50' : ''}`}>
        <div className={`mt-0.5 rounded-full p-0.5 shrink-0 ${highlighted ? 'bg-primary/20 text-primary' : 'bg-gray-100 text-gray-500'}`}>
            {icon || <Check className="h-3.5 w-3.5" />}
        </div>
        <span className={`text-sm ${bold ? 'font-bold text-gray-900' : 'text-gray-600'} ${highlighted ? 'text-primary font-semibold' : ''} ${dimmed ? 'line-through' : ''}`}>
            {text}
        </span>
    </li>
);

export default SaaSPlansPage;
