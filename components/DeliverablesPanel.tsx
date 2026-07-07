"use client";

import { useEffect, useState, useTransition } from "react";
import {
  generateClientProposal,
  generatePitchDeck,
  type ClientProposal,
  type PitchDeck,
} from "@/app/actions/deliverables";
import { listOpportunities } from "@/app/actions/opportunities";
import type { Opportunity } from "@/lib/db-types";

// Employee-portal panel: generate a client proposal and a pitch deck for an
// opportunity, preview them, and export the deck as .pptx (Amazon styling).
export default function DeliverablesPanel() {
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [opportunityId, setOpportunityId] = useState("");
  const [proposal, setProposal] = useState<ClientProposal | null>(null);
  const [deck, setDeck] = useState<PitchDeck | null>(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    listOpportunities().then((res) => {
      if (res.ok && res.data && res.data.length > 0) {
        setOpps(res.data);
        setOpportunityId(res.data[0].id);
      }
    });
  }, []);

  function makeProposal() {
    startTransition(async () => {
      const res = await generateClientProposal(opportunityId);
      if (!res.ok || !res.data) return setError(res.error ?? "Failed.");
      setError("");
      setProposal(res.data);
    });
  }

  function makeDeck() {
    startTransition(async () => {
      const res = await generatePitchDeck(opportunityId);
      if (!res.ok || !res.data) return setError(res.error ?? "Failed.");
      setError("");
      setDeck(res.data);
    });
  }

  async function exportPptx() {
    if (!deck) return;
    const PptxGenJS = (await import("pptxgenjs")).default;
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
    pptx.layout = "WIDE";

    deck.slides.forEach((slide, i) => {
      const s = pptx.addSlide();
      s.background = { color: i === 0 ? "232F3E" : "FFFFFF" };
      s.addText(slide.title, {
        x: 0.6, y: 0.4, w: 12, h: 1,
        fontSize: i === 0 ? 30 : 24, bold: true,
        color: i === 0 ? "FFFFFF" : "131A22",
        fontFace: "Arial",
      });
      s.addShape("rect", { x: 0.6, y: 1.35, w: 1.6, h: 0.07, fill: { color: "FF9900" } });
      s.addText(
        slide.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
        {
          x: 0.6, y: 1.7, w: 12, h: 5,
          fontSize: 15, color: i === 0 ? "DDDDDD" : "333333",
          fontFace: "Arial", valign: "top",
        },
      );
    });
    await pptx.writeFile({
      fileName: deck.companyName.replace(/\s+/g, "-") + "-ASCS-pitch.pptx",
    });
  }

  return (
    <section>
      <h2 className="mb-3 text-base font-bold">Client Proposal &amp; Pitch Deck</h2>
      <div className="rounded-sm border border-border bg-surface p-4">
        {opps.length === 0 ? (
          <p className="mb-3 text-sm text-gray-500">
            No opportunities in the database yet. Create one first — deliverables are generated from live opportunity data.
          </p>
        ) : (
          <div className="mb-3">
            <label htmlFor="opp-select" className="mb-1 block text-sm font-medium">
              Opportunity
            </label>
            <select
              id="opp-select"
              value={opportunityId}
              onChange={(e) => setOpportunityId(e.target.value)}
              className="h-11 w-full rounded-sm border border-border bg-surface px-2 text-sm"
            >
              {opps.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.company_name} — {o.industry}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={makeProposal}
            disabled={pending || !opportunityId}
            className="h-11 rounded-sm bg-orange px-4 text-sm font-medium text-ink hover:bg-orange-dark disabled:opacity-60"
          >
            {pending ? "Working…" : "Generate proposal"}
          </button>
          <button
            onClick={makeDeck}
            disabled={pending || !opportunityId}
            className="h-11 rounded-sm border border-border px-4 text-sm font-medium text-link hover:bg-gray-50 disabled:opacity-60"
          >
            Generate pitch deck
          </button>
          {deck ? (
            <button
              onClick={exportPptx}
              className="h-11 rounded-sm border border-border px-4 text-sm font-medium text-link hover:bg-gray-50"
            >
              Download .pptx
            </button>
          ) : null}
        </div>
        {error ? (
          <p className="mt-3 text-sm text-danger" role="alert">{error}</p>
        ) : null}

        {proposal ? (
          <article className="mt-4 space-y-3 border-t border-border pt-4">
            {proposal.sections.map((sec) => (
              <div key={sec.heading}>
                <h3 className="text-sm font-bold">{sec.heading}</h3>
                <ul className="mt-1 list-disc pl-5 text-sm text-gray-700">
                  {sec.body.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="text-xs text-gray-500">{proposal.disclaimer}</p>
          </article>
        ) : null}

        {deck ? (
          <div className="mt-4 grid gap-2 border-t border-border pt-4 sm:grid-cols-2">
            {deck.slides.map((s, i) => (
              <div key={i} className="rounded-sm border border-border p-3">
                <p className="text-xs text-gray-500">Slide {i + 1}</p>
                <p className="text-sm font-bold">{s.title}</p>
                <ul className="mt-1 list-disc pl-4 text-xs text-gray-600">
                  {s.bullets.slice(0, 3).map((b, j) => (
                    <li key={j}>{b}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
