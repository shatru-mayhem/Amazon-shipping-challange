"use client";

import { useState } from "react";
import Link from "next/link";
import TopBar from "@/components/TopBar";
import LoginModal, { type PortalKind } from "@/components/LoginModal";

const clientFeatures = [
  "Digital Twin Pipeline with approval points and issue flags",
  "Q&A area routed by category to the right Amazon team",
  "Secure document upload into labeled categories",
  "Progress tracker: uploaded, viewed, reviewed, answered",
  "Project switcher for multi-project accounts",
];

const employeeFeatures = [
  "Hierarchy-based dashboard for your role in the chain",
  "Document review folders with restricted access",
  "Q&A answer bar filtered to your area of work",
  "Proposal chat: risks, opportunities, costs",
  "Challenge brief and client evaluation area",
];

export default function LandingPage() {
  const [portal, setPortal] = useState<PortalKind | null>(null);

  return (
    <main className="min-h-screen">
      <TopBar />

      <section className="bg-navy text-white">
        <div className="mx-auto max-w-7xl px-4 py-10">
          <h1 className="text-2xl font-bold">
            Amazon Supply Chain Services Portal
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-gray-300">
            One end-to-end logistics platform, from upstream transportation and
            storage through last-mile delivery with Amazon Shipping. Select
            your entrance to continue.
          </p>
          <Link
            href="/architecture"
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-orange hover:underline"
          >
            See how the solution actually works — data flow &amp; architecture →
          </Link>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-8">
        <div className="grid gap-6 md:grid-cols-2">
          <PortalCard
            title="Client Portal"
            subtitle="For businesses working with Amazon Supply Chain Services"
            features={clientFeatures}
            cta="Sign in as client"
            onEnter={() => setPortal("client")}
          />
          <PortalCard
            title="Amazon Employee Portal"
            subtitle="Internal access, tailored to your hierarchy and tasks"
            features={employeeFeatures}
            cta="Sign in as Amazon employee"
            onEnter={() => setPortal("employee")}
          />
        </div>

        <div className="mt-8 rounded-md border border-border bg-surface p-4 text-sm text-gray-600">
          <span className="font-medium text-ink">Access control:</span>{" "}
          code-access with email confirmation. Modular UI components and open
          input ports support backend integration via APIs.
        </div>
      </section>

      {portal ? (
        <LoginModal portal={portal} onClose={() => setPortal(null)} />
      ) : null}
    </main>
  );
}

function PortalCard({
  title,
  subtitle,
  features,
  cta,
  onEnter,
}: {
  title: string;
  subtitle: string;
  features: string[];
  cta: string;
  onEnter: () => void;
}) {
  return (
    <div className="flex flex-col rounded-md border border-border bg-surface p-6">
      <h2 className="text-lg font-bold">{title}</h2>
      <p className="mt-1 text-sm text-gray-600">{subtitle}</p>
      <ul className="mt-4 flex-1 space-y-2 text-sm">
        {features.map((f) => (
          <li key={f} className="flex gap-2">
            <span aria-hidden="true" className="text-orange">
              ▸
            </span>
            <span>{f}</span>
          </li>
        ))}
      </ul>
      <button
        onClick={onEnter}
        className="mt-6 h-11 rounded-sm bg-orange px-4 font-medium text-ink hover:bg-orange-dark"
      >
        {cta}
      </button>
    </div>
  );
}
