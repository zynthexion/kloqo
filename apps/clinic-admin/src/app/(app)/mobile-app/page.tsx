
"use client";

import { MobileAppHeader } from "@/components/layout/header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Smartphone } from "lucide-react";

export default function MobileAppPage() {
  return (
    <>
      <div>
        <MobileAppHeader />
        <main className="flex-1 p-6 bg-background">
          <Card className="max-w-2xl mx-auto">
            <CardHeader className="text-center">
                <Smartphone className="h-12 w-12 mx-auto text-primary" />
                <CardTitle className="mt-4">Mobile Token Management</CardTitle>
                <CardDescription>
                    Manage your token queues on the go.
                </CardDescription>
            </CardHeader>
            <CardContent className="text-center">
                <p className="text-muted-foreground">
                    Download the mobile application from the app store and use the credentials
                    set in your profile to log in.
                </p>
            </CardContent>
          </Card>
        </main>
      </div>
    </>
  );
}
