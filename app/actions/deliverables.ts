"use server";

import { getDigitalTwin } from "@/app/actions/opportunities";
import { evaluateOpportunity } from "@/app/actions/proposal";
import { logAuditEvent } from "@/app/actions/audit";
import type { ActionResult } from "@/app/actions/auth";

// Client Proposal + Pitch Deck generation (deterministic, guardrailed).
// Content is assembled strictly from intake data and the proposal
// evaluator — no pricing, delivery-speed, or capacity commitments.
// LLM SWAP POINT: replace the assembly functions with a server-side LLM
// call returning these same shapes.

export interface ProposalSection {
  heading: string;
  body: string[];
}

export interface ClientProposal {
  companyName: string;
  generatedBy: string;
  sections: ProposalSection[];
  disclaimer: string;
}

export interface DeckSlide {
  title: string;
  bullets: string[];
}

export interface PitchDeck {
  companyName: string;
  slides: DeckSlide[];
}

const DISCLAIMER =
  "Draft for internal review. Contains no pricing, delivery-speed, or capacity commitments. Human approval required before sharing externally.";

export async function generateClientProposal(
  opportunityId: string,
): Promise<ActionResult<ClientProposal>> {
  const twin = await getDigitalTwin(opportunityId);
  if (!twin.ok || !twin.data) return { ok: false, error: twin.error };
  const evalRes = await evaluateOpportunity(opportunityId);
  if (!evalRes.ok || !evalRes.data) return { ok: false, error: evalRes.error };

  const { opportunity, intake, missingFields } = twin.data;
  const signals = evalRes.data.signals;
  const pick = (k: "Risk" | "Opportunity" | "Cost") =>
    signals.filter((s) => s.kind === k).map((s) => s.text);

  const proposal: ClientProposal = {
    companyName: opportunity.company_name,
    generatedBy: "deterministic-rules-v1",
    sections: [
      {
        heading: "Account Overview",
        body: [
          opportunity.company_name + " — " + opportunity.industry + ".",
          "Current logistics model: " + (intake?.current_model ?? "not captured") + ".",
          "Volume band: " + (intake?.volume_band ?? "not captured") + ".",
        ],
      },
      {
        heading: "Customer Need",
        body: [
          "Goals: " + (intake?.customer_goals ?? "not captured") + ".",
          "Constraints: " + (intake?.constraints ?? "not captured") + ".",
          "Warehousing needs: " + (intake?.warehousing_needs ?? "not captured") + ".",
        ],
      },
      {
        heading: "Recommended ASCS Configuration",
        body: [
          "ASCS end-to-end portfolio configured around this opportunity: upstream transportation, warehousing, inventory management, and parcel delivery as applicable.",
          "Amazon Shipping serves as the last-mile delivery component — not the entire solution.",
        ],
      },
      { heading: "Why This Fits", body: pick("Opportunity") },
      { heading: "Risks and Constraints", body: pick("Risk") },
      { heading: "Commercial Considerations", body: pick("Cost") },
      {
        heading: "Open Questions",
        body: missingFields.length
          ? missingFields.map((f) => "Missing intake field: " + f)
          : ["None — intake profile is complete."],
      },
    ],
    disclaimer: DISCLAIMER,
  };

  await logAuditEvent({
    eventType: "deliverable.proposal_generated",
    opportunityId,
    after: { generatedBy: proposal.generatedBy },
  });
  return { ok: true, data: proposal };
}

export async function generatePitchDeck(
  opportunityId: string,
): Promise<ActionResult<PitchDeck>> {
  const proposalRes = await generateClientProposal(opportunityId);
  if (!proposalRes.ok || !proposalRes.data)
    return { ok: false, error: proposalRes.error };
  const p = proposalRes.data;

  const section = (h: string) =>
    p.sections.find((s) => s.heading === h)?.body ?? [];

  const deck: PitchDeck = {
    companyName: p.companyName,
    slides: [
      {
        title: p.companyName + " × Amazon Supply Chain Services",
        bullets: ["Opportunity overview and recommended configuration", DISCLAIMER],
      },
      { title: "Account Overview", bullets: section("Account Overview") },
      { title: "Customer Need", bullets: section("Customer Need") },
      {
        title: "Recommended ASCS Configuration",
        bullets: section("Recommended ASCS Configuration"),
      },
      { title: "Why This Fits", bullets: section("Why This Fits") },
      { title: "Risks and Constraints", bullets: section("Risks and Constraints") },
      {
        title: "Commercial Considerations",
        bullets: section("Commercial Considerations"),
      },
      {
        title: "Next Steps",
        bullets: [
          "Resolve open questions listed in the proposal",
          "Route to specialist review where flagged",
          "Human approval before any external sharing",
        ],
      },
    ],
  };

  await logAuditEvent({
    eventType: "deliverable.deck_generated",
    opportunityId,
    after: { slides: deck.slides.length },
  });
  return { ok: true, data: deck };
}
