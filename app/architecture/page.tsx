"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import TopBar from "@/components/TopBar";
import ArchitectureDiagram from "@/components/ArchitectureDiagram";

// Public (not gated by middleware.ts — only /client and /employee are
// protected). Built for the people deciding whether to implement this
// solution: a real, clickable map of how two separate companies' systems
// (client tender docs, Amazon CRM/email) feed a shared schema, which an
// internal reference layer and a pure-SQL derived layer sit between,
// before the 9 skills compose a decision-ready output.
//
// Also doubles as the employee post-login landing page (?next=employee):
// employees land here first instead of straight on the dashboard, and
// click "Try it out" when ready to enter Unified Intelligence.
export default function ArchitecturePage() {
  return (
    <Suspense fallback={null}>
      <ArchitecturePageContent />
    </Suspense>
  );
}

function ArchitecturePageContent() {
  const searchParams = useSearchParams();
  const next = searchParams.get("next");
  const nextHref = next === "employee" ? "/employee/dashboard" : null;

  return (
    <main className="min-h-screen">
      <TopBar context="Solution Architecture" showBack={!!nextHref} />
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6">
          {nextHref ? null : (
            <Link href="/" className="text-sm text-link hover:underline">
              ← Back
            </Link>
          )}
          <h1 className="mt-2 text-xl font-bold text-ink">How the data actually flows</h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-600">
            Two separate companies&rsquo; systems — the client&rsquo;s tender
            documents and Amazon&rsquo;s own CRM/email — write into one shared
            schema. A curated internal reference layer and a pure-SQL derived
            layer sit between that and the 9 outputs on the executive
            dashboard. Click any box below.
          </p>
          {nextHref ? (
            <Link
              href={nextHref}
              className="mt-4 inline-flex h-11 items-center rounded-sm bg-orange px-4 text-sm font-medium text-ink hover:bg-orange-dark"
            >
              Try it out →
            </Link>
          ) : null}
        </div>
        <ArchitectureDiagram />
      </div>
    </main>
  );
}
