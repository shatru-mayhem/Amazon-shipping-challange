"use client";

import TopBar from "@/components/TopBar";
import TeamPanel from "@/components/TeamPanel";
import KnowledgePanel from "@/components/KnowledgePanel";
import DeliverablesPanel from "@/components/DeliverablesPanel";
import TenderUploadPanel from "@/components/TenderUploadPanel";
import EmailImportPanel from "@/components/EmailImportPanel";
import CapabilityIngestionPanel from "@/components/CapabilityIngestionPanel";
import RetrievalStatusPanel from "@/components/RetrievalStatusPanel";

// Operations & administration. These panels predate the Unified
// Intelligence redesign (FigmaDashboard) and were left unmounted by it —
// TeamPanel in particular is the only UI where the head account can add
// employees and assign hierarchy, without which new employees can never
// obtain the Employee role. Remounted here rather than folded into
// FigmaDashboard to keep that redesign untouched.
export default function OperationsPage() {
  return (
    <main className="min-h-screen">
      <TopBar context="Operations" showBack />
      <div className="mx-auto max-w-7xl px-4 py-6">
        <h1 className="mb-6 text-lg font-bold">Operations &amp; Administration</h1>
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="space-y-8">
            <TeamPanel />
            <TenderUploadPanel />
            <EmailImportPanel />
          </div>
          <div className="space-y-8">
            <KnowledgePanel />
            <DeliverablesPanel />
            <CapabilityIngestionPanel />
            <RetrievalStatusPanel />
          </div>
        </div>
      </div>
    </main>
  );
}
