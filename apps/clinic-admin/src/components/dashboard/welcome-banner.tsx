"use client";

import Image from "next/image";
import { Card, CardContent } from "@/components/ui/card";

export default function WelcomeBanner() {
  return (
    <Card className="bg-primary text-primary-foreground overflow-hidden">
      <CardContent className="p-6 flex items-center justify-between">
        <div className="flex-1">
          <h2 className="text-2xl font-bold">Hello, Zaenal Suep</h2>
          <p className="mt-2 text-sm max-w-md">
            You have an unfinished job. Among them are 2 design tasks, 3 mockup
            tasks and 2 layouts. Work for the week is very good, already in
            progress 70%.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
