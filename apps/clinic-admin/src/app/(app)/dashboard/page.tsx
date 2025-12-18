
'use client';

import { useState, Suspense, useRef, forwardRef, useCallback } from "react";
import { format, subDays } from "date-fns";
import { useReactToPrint } from "react-to-print";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import OverviewStats from "@/components/dashboard/overview-stats";
import DoctorAvailability from "@/components/dashboard/doctor-availability";
import TodaysAppointments from "@/components/dashboard/todays-appointments";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Calendar } from "@/components/ui/calendar";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Printer, FileDown, Loader2 } from "lucide-react";
import AppointmentStatusChart from "@/components/dashboard/appointment-status-chart";
import PatientsVsAppointmentsChart from "@/components/dashboard/patients-vs-appointments-chart";
import PeakHoursChart from "@/components/dashboard/peak-hours-chart";
import PDFReport from "@/components/dashboard/pdf-report";
import { useSearchParams } from "next/navigation";
import Link from "next/link";


// A new component that correctly forwards the ref for printing.
const PrintableContent = forwardRef<HTMLDivElement, {
  children: React.ReactNode;
  dateRange: DateRange | undefined;
  selectedDate: Date;
  isPrintMode?: boolean;
}>(({ children, dateRange, selectedDate, isPrintMode = false }, ref) => {
  return (
    <div ref={ref} className="flex-1 p-6 bg-background">
      {isPrintMode ? (
        <PDFReport dateRange={dateRange} selectedDate={selectedDate} />
      ) : (
        children
      )}
    </div>
  );
});
PrintableContent.displayName = 'PrintableContent';


function DashboardPageContent() {
  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: subDays(new Date(), 6),
    to: new Date(),
  });
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [isPrinting, setIsPrinting] = useState(false);
  const [isPrintMode, setIsPrintMode] = useState(false);

  const contentToPrintRef = useRef<HTMLDivElement>(null);

  const handlePrint = useCallback(() => {
    console.log("Print button clicked, setting print mode to true");
    setIsPrintMode(true);
    setTimeout(() => {
      console.log("Triggering print dialog");
      window.print();
      setTimeout(() => {
        setIsPrintMode(false);
        console.log("Print mode reset to false");
      }, 1000);
    }, 500);
  }, []);

  const handleDownloadPdf = useCallback(async () => {
    console.log("PDF button clicked, setting print mode to true");
    setIsPrinting(true);
    setIsPrintMode(true);

    try {
      // Wait for the print mode to render
      console.log("Waiting for print mode to render...");
      await new Promise(resolve => setTimeout(resolve, 1000));

      const content = contentToPrintRef.current;
      console.log("Content element:", content);
      if (!content) {
        console.log("No content element found");
        return;
      }

      const canvas = await html2canvas(content, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff'
      });

      const imgData = canvas.toDataURL('image/png', 1.0);

      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
      });

      const imgWidth = 210; // A4 width in mm
      const pageHeight = 295; // A4 height in mm
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      let heightLeft = imgHeight;

      let position = 0;

      pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;

      while (heightLeft >= 0) {
        position = heightLeft - imgHeight;
        pdf.addPage();
        pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
      }

      const fileName = `clinic-dashboard-report-${format(dateRange?.from || new Date(), 'yyyy-MM-dd')}-to-${format(dateRange?.to || new Date(), 'yyyy-MM-dd')}.pdf`;
      pdf.save(fileName);

    } catch (error) {
      console.error("Error generating PDF:", error);
    } finally {
      setIsPrinting(false);
      setIsPrintMode(false);
    }
  }, [dateRange]);

  const handleDateSelect = useCallback((date: Date | undefined) => {
    if (date) {
      setSelectedDate(date);
    }
  }, []);

  return (
    <>
      <header className="flex items-center justify-between gap-4 px-6 border-b py-6">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
        </div>
        <div className="flex items-center gap-4">
          <DateRangePicker
            onDateChange={setDateRange}
            initialDateRange={dateRange}
          />
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={isPrinting}
              onClick={handlePrint}
              className="flex items-center gap-2 hover:bg-blue-50 hover:border-blue-300 transition-colors"
            >
              <Printer className="h-4 w-4" />
              Print Report
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={isPrinting}
              onClick={handleDownloadPdf}
              className="flex items-center gap-2 hover:bg-green-50 hover:border-green-300 transition-colors"
            >
              {isPrinting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
              {isPrinting ? 'Generating...' : 'Download PDF'}
            </Button>

          </div>
        </div>
      </header>

      <PrintableContent
        ref={contentToPrintRef}
        dateRange={dateRange}
        selectedDate={selectedDate}
        isPrintMode={isPrintMode}
      >
        <div className="space-y-6">
          <OverviewStats dateRange={dateRange} />
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-3">
              <AppointmentStatusChart dateRange={dateRange} />
            </div>
            <div className="lg:col-span-6">
              <PatientsVsAppointmentsChart dateRange={dateRange} />
            </div>
            <div className="lg:col-span-3">
              <Card className="h-full flex flex-col bg-[#dcf2eb] overflow-hidden">
                <CardContent className="flex-grow flex items-center justify-center">
                  <Calendar
                    mode="single"
                    selected={selectedDate}
                    onSelect={handleDateSelect}
                    className="w-full border-0 shadow-none bg-transparent [&_button]:text-base [&_caption]:text-lg"
                  />
                </CardContent>
              </Card>
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1">
              <PeakHoursChart dateRange={dateRange} />
            </div>
            <div className="lg:col-span-1">
              <TodaysAppointments selectedDate={selectedDate} />
            </div>
            <div className="lg:col-span-1">
              <DoctorAvailability selectedDate={selectedDate} />
            </div>
          </div>
        </div>
      </PrintableContent>
    </>
  );
}


export default function DashboardPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <DashboardPageContent />
    </Suspense>
  )
}
