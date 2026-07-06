"use server";

import { getDigitalTwin } from "@/app/actions/opportunities";
import { logAuditEvent } from "@/app/actions/audit";
import type { ActionResult } from "@/app/actions/auth";

// Feature 5 (webdev.md): Proposal Integration Chat.
// Deterministic, guardrailed evaluation constrained to current execution
// capabilities. Returns strictly typed JSON (Risks / Opportunities / Costs).
//
// LLM SWAP POINT: replace evaluateSignals() with a server-side LLM call
// returning this same ProposalEvaluation shape. Keys stay server-only.

export interface ProposalSignalItem {
  kind: "Risk" | "Opportunity" | "Cost";
  text: string;
  source: string; // which intake field drove this signal
}

export interface ProposalEvaluation {
  opportunityId: string;
  generatedBy: string;
  signals: ProposalSignalItem[];
  missingInformation: string[];
  disclaimer: string;
}

const HIGH_VOLUME_BANDS = ["50k-250k", "250k+", "High"];

export async function evaluateOpportunity(
  opportunityId: string,
): Promise<ActionResult<ProposalEvaluation>> {
  const twin = await getDigitalTwin(opportunityId);
  if (!twin.ok || !twin.data) return { ok: false, error: twin.error };

  const { intake, missingFields } = twin.data;
  const signals: ProposalSignalItem[] = [];

  if (intake?.peak_seasonality?.toLowerCase().includes("peak")) {
    signals.push({
      kind: "Risk",
      text: "Peak seasonality declared. Warehousing capacity must be confirmed before commitment.",
      source: "peak_seasonality",
    });
  }
  if (intake?.integration_readiness?.toLowerCase().includes("low")) {
    signals.push({
      kind: "Risk",
      text: "Low integration readiness. Onboarding effort and timeline risk increase.",
      source: "integration_readiness",
    });
  } else if (intake?.integration_readiness) {
    signals.push({
      kind: "Opportunity",
      text: "Existing integration readiness shortens onboarding.",
      source: "integration_readiness",
    });
  }
  if (intake?.volume_band && HIGH_VOLUME_BANDS.some((b) => intake.volume_band!.includes(b))) {
    signals.push({
      kind: "Opportunity",
      text: "High parcel volume fits Amazon Shipping last-mile economics.",
      source: "volume_band",
    });
  }
  if (intake?.warehousing_needs) {
    signals.push({
      kind: "Cost",
      text: "Warehousing requirement adds storage and handling cost. Pricing review required.",
      source: "warehousing_needs",
    });
  }
  if (intake?.carrier_mix && intake.carrier_mix.split(",").length > 2) {
    signals.push({
      kind: "Cost",
      text: "Fragmented carrier mix implies migration and dual-running costs during transition.",
      source: "carrier_mix",
    });
  }
  if (signals.length === 0) {
    signals.push({
      kind: "Risk",
      text: "Insufficient intake data to generate signals. Complete the intake profile.",
      source: "intake_profile",
    });
  }

  const evaluation: ProposalEvaluation = {
    opportunityId,
    generatedBy: "deterministic-rules-v1", // AuditEvent tags output as machine-generated
    signals,
    missingInformation: missingFields,
    disclaimer:
      "Machine-generated evaluation. No pricing, delivery-speed, or capacity commitment. Human review required.",
  };

  await logAuditEvent({
    eventType: "proposal.evaluated",
    opportunityId,
    after: { generatedBy: evaluation.generatedBy, signalCount: signals.length },
  });

  return { ok: true, data: evaluation };
}
