"use client";

import Link from "next/link";
import TopBar from "@/components/TopBar";
import SoftwareAnalyticsDashboard from "@/components/SoftwareAnalyticsDashboard";

// Standalone view of the pipeline's own operating telemetry (tokens,
// latency, success rate per LLM call) — separate from ExecutiveDashboard,
// which is per-opportunity business output. This page is system-wide.
export default function SoftwareAnalyticsPage() {
  return (
    <main className="min-h-screen">
      <TopBar context="Software Analytics" />
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 flex items-center gap-3">
          <Link href="/employee" className="text-sm text-link hover:underline">
            ← Operations Dashboard
          </Link>
        </div>
        <SoftwareAnalyticsDashboard />
      </div>
    </main>
  );
}
