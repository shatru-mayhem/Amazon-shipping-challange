"use client";

import Link from "next/link";
import TopBar from "@/components/TopBar";
import ExecutiveDashboard from "@/components/ExecutiveDashboard";

// Standalone executive view of the flow.jpeg pipeline: every skill from
// tender/email ingestion through to the executive-summary decision
// prompt, for one opportunity, in one place — not spread across the
// Operations Dashboard's other panels.
export default function ExecutiveDashboardPage() {
  return (
    <main className="min-h-screen">
      <TopBar context="Executive Dashboard" />
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 flex items-center gap-3">
          <Link href="/employee" className="text-sm text-link hover:underline">
            ← Operations Dashboard
          </Link>
        </div>
        <ExecutiveDashboard />
      </div>
    </main>
  );
}
