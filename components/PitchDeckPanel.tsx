"use client";

import { useMemo, useState } from "react";
import type { Dashboard } from "@/lib/dashboard-types";
import { buildPitchDeckSlides } from "@/lib/build-pitch-deck";

// Client-facing pitch deck: lightweight HTML preview of the same data
// ExecutiveDashboard already fetched, plus a .pptx export using the same
// pptxgenjs pattern DeliverablesPanel.tsx already uses successfully
// (Amazon navy/orange branding, 16:9 WIDE layout).

export default function PitchDeckPanel({
  dashboard,
  customerName,
  opportunityTitle,
}: {
  dashboard: Dashboard;
  customerName: string;
  opportunityTitle: string;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const slides = useMemo(
    () => buildPitchDeckSlides(dashboard, customerName, opportunityTitle),
    [dashboard, customerName, opportunityTitle],
  );

  const hasHardBlocker = dashboard.client_proposal.internal_flags.has_hard_blocker;
  const canDownload = !hasHardBlocker || acknowledged;
  const pricingScenario = dashboard.client_proposal.sections.commercial_proposal.scenario;

  async function exportPptx() {
    const PptxGenJS = (await import("pptxgenjs")).default;
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
    pptx.layout = "WIDE";

    slides.forEach((slide, i) => {
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
      fileName: `${customerName.replace(/\s+/g, "-")}-ASCS-pitch.pptx`,
    });
  }

  return (
    <div className="rounded-md border-2 border-navy bg-surface p-5">
      <p className="mb-3 text-xs font-bold uppercase tracking-wide text-navy">Pitch Deck</p>

      {hasHardBlocker ? (
        <div className="mb-4 rounded-sm border border-danger bg-danger/10 p-3">
          <p className="text-xs font-bold uppercase tracking-wide text-danger">
            ⚠ This opportunity has an unresolved hard blocker
          </p>
          <p className="mt-1 text-xs text-danger">
            The deck itself never promises a blocked capability, but review the blocker
            before sharing this deck externally.
          </p>
          <label className="mt-2 flex items-center gap-2 text-xs font-medium text-danger">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            I've reviewed the hard blocker and this deck is still appropriate to share.
          </label>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {slides.map((slide, i) => (
          <div
            key={i}
            className={
              "flex aspect-video flex-col rounded-sm border p-3 " +
              (i === 0 ? "border-navy bg-navy text-white" : "border-border bg-surface")
            }
          >
            <p className={"mb-1 text-xs font-bold uppercase " + (i === 0 ? "text-orange" : "text-orange-dark")}>
              Slide {i + 1}
            </p>
            <p className="mb-1 text-sm font-bold leading-snug">{slide.title}</p>
            <ul className={"space-y-0.5 overflow-hidden text-[11px] leading-snug " + (i === 0 ? "text-gray-300" : "text-gray-600")}>
              {slide.bullets.slice(0, 4).map((b, j) => (
                <li key={j} className="line-clamp-2">• {b}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {pricingScenario?.calculation?.length ? (
        <details className="mt-4 rounded-sm border border-border bg-canvas p-3">
          <summary className="cursor-pointer text-xs font-bold uppercase tracking-wide text-navy select-none">
            Show the math behind this price (internal only — not in the exported deck)
          </summary>
          <ol className="mt-2 space-y-1.5 border-l-2 border-border pl-3">
            {pricingScenario.calculation.map((s, i) => (
              <li key={i} className="text-xs">
                <span className="text-gray-500">{s.label}:</span>{" "}
                <code className="text-gray-700">{s.expression}</code>
                {s.unit ? <span className="text-gray-400"> {s.unit}</span> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      <button
        onClick={exportPptx}
        disabled={!canDownload}
        className="mt-4 h-11 rounded-sm bg-orange px-4 text-sm font-medium text-ink hover:bg-orange-dark disabled:opacity-50"
      >
        Download .pptx
      </button>
    </div>
  );
}
