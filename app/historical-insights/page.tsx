"use client";

import Link from "next/link";
import TopBar from "@/components/TopBar";
import HistoricalInsightsDashboard from "@/components/HistoricalInsightsDashboard";

// PCA + clustering analysis over the 360 real historical tenders
// (skills/exploration/historical_archetypes.py), feeding findings back
// into RETRIEVAL_REQUIREMENTS.md — the doc that maps which skill/page
// needs which extracted field.
export default function HistoricalInsightsPage() {
  return (
    <main className="min-h-screen">
      <TopBar context="Historical Insights" showBack backHref="/employee/dashboard" backLabel="← Unified Intelligence" />
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6">
          <Link href="/employee/dashboard" className="text-sm text-link hover:underline">
            ← Unified Intelligence
          </Link>
          <h1 className="mt-2 text-xl font-bold text-ink">Historical Tender Analysis</h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-600">
            A look back at 360 past tenders to find what actually separates a won deal
            from a lost one — which factors matter most, and what types of opportunities
            tend to come up again and again.
          </p>
        </div>
        <HistoricalInsightsDashboard />
      </div>
    </main>
  );
}
