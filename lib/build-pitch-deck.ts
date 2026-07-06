import type { Dashboard } from "@/lib/dashboard-types";
import { CAPABILITIES_SLIDE_BULLETS, IMPLEMENTATION_PLAN_BULLETS } from "@/lib/pitch-deck-content";

// Builds the 7 client-facing pitch deck slides from already-fetched real
// skill output (client_proposal / commercial_strategy / executive_summary).
// Pure data transform — no IO, no LLM call. Deterministic composition only:
// the underlying skills (skills/client_proposal, skills/commercial_strategy)
// already keep internal-only hard-blocker content out of client-facing
// fields, so this function just picks fields, it never needs to filter.

export interface DeckSlide {
  title: string;
  bullets: string[];
}

export function buildPitchDeckSlides(
  d: Dashboard,
  customerName: string,
  opportunityTitle: string,
): DeckSlide[] {
  const cp = d.client_proposal.sections;
  const cs = d.commercial_strategy;
  const scenario = cp.commercial_proposal.scenario;

  return [
    {
      title: `${customerName} × Amazon Shipping Spain`,
      bullets: [
        opportunityTitle,
        new Date().toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" }),
      ],
    },
    {
      title: "Executive Summary",
      bullets: [
        d.executive_summary.headline,
        d.executive_summary.decision_prompt,
        `Opportunity score: ${d.opportunity_score.band.toUpperCase()} (${d.opportunity_score.score}/100)`,
        `Win probability: ${Math.round(d.win_probability.win_probability * 100)}%`,
      ].filter(Boolean),
    },
    {
      title: "Amazon Shipping Spain Capabilities",
      bullets: CAPABILITIES_SLIDE_BULLETS,
    },
    {
      title: "Why This Fits Your Needs",
      bullets: [
        cs.positioning_statement,
        ...cs.align_to_priorities.map((p) => `Aligns with: ${p}`),
        ...cs.address_client_pains.map((p) => `Addresses: ${p}`),
      ].filter(Boolean),
    },
    {
      title: "Proposed Pricing",
      bullets: scenario
        ? [
            `${cp.commercial_proposal.selected_scenario.toUpperCase()} scenario: ${scenario.target_margin_pct}% target margin`,
            `Estimated price: €${scenario.price_per_package_eur.toLocaleString()} per package`,
            scenario.rationale,
            scenario.negotiation_strategy,
          ]
        : ["Pricing to be confirmed once scope and volumes are finalized."],
    },
    {
      title: "Implementation Plan",
      bullets: IMPLEMENTATION_PLAN_BULLETS,
    },
    {
      title: "Why Amazon Shipping",
      bullets: [
        cp.why_amazon_shipping.positioning,
        ...cp.why_amazon_shipping.differentiators.map((s) => s.replace(/_/g, " ")),
        ...cp.why_amazon_shipping.proof_points,
        ...cp.next_steps.points,
      ].filter(Boolean),
    },
  ];
}
