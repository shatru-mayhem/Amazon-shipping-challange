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
      <TopBar context="Historical Insights" showBack />
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6">
          <Link href="/employee/dashboard" className="text-sm text-link hover:underline">
            ← Unified Intelligence
          </Link>
          <h1 className="mt-2 text-xl font-bold text-ink">Historical Tender Analysis</h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-600">
            PCA and clustering over 360 historical tenders to find which features
            actually drive win rate, group opportunities into archetypes, and flag
            which fields matter most for retrieval accuracy.
          </p>
        </div>
        <HistoricalInsightsDashboard />
      </div>
    </main>
  );
}
