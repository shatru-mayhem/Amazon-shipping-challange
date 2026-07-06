"use client";

import { useEffect, useState, useTransition } from "react";
import StatusBadge, { type StatusTone } from "@/components/StatusBadge";
import { listOpportunitiesForIngestion, type OpportunityOption } from "@/app/actions/tender_ingestion";

// Executive dashboard, structured around the 9 required outputs (not an
// arbitrary set of business questions): Executive Summary, Opportunity
// Score, Risk Assessment, Pricing Recommendation, Commercial Strategy,
// Required Follow-Up Actions, Client Proposal / Pitch Deck, Win
// Probability Score, Sources Used. Each still runs exactly once via the
// existing /api/skill + /api/retrieve bridges (skills/*.py); this
// renders their real, already-tested output instead of a JSON dump.

interface OpportunityScore {
  score: number;
  band: "hot" | "warm" | "cold";
  rationale: string;
  has_hard_blocker?: boolean;
}

interface WinProbability {
  win_probability: number;
  base_rate: number;
  top_drivers: { factor: string; effect: number }[];
  rationale: string;
}

interface Risk {
  category: string;
  severity: "low" | "medium" | "high";
  title: string;
  detail: string;
  hard_blocker?: boolean;
}

interface RiskAssessment {
  overall_risk: "none" | "low" | "medium" | "high";
  risk_count: number;
  risks: Risk[];
  has_hard_blocker: boolean;
  hard_blockers: Risk[];
}

interface CapabilityGap {
  constraint_name: string;
  result: "unsatisfied" | "unclear_needs_verification";
  severity: "low" | "medium" | "high";
  gap_description: string;
  is_hard_blocker: boolean;
}

interface CommercialStrategy {
  positioning_statement: string;
  lead_with_strengths: string[];
  address_client_pains: string[];
  align_to_priorities: string[];
  objections_to_preempt: string[];
  negotiation_approach: string;
  capability_gaps_to_flag: CapabilityGap[];
  has_hard_blocker: boolean;
}

interface PricingScenario {
  name: "aggressive" | "balanced" | "premium";
  target_margin_pct: number;
  implied_price_eur: number | null;
  rationale: string;
  tradeoffs: string;
  negotiation_strategy: string;
  guardrail_result?: string;
  floor_applied?: boolean;
  floor_note?: string;
}

interface PricingRecommendations {
  recommended_scenario: string;
  scenarios: PricingScenario[];
  guardrails: string[];
  financial_guardrails: {
    min_contribution_margin_pct: number;
    target_contribution_margin_pct: number;
    vp_approval_required_below_pct: number;
    auto_no_go_below_pct: number;
  } | null;
}

interface FollowUpAction {
  priority: "high" | "medium" | "low";
  action: string;
  detail: string;
  type?: string;
}

interface FollowUpActions {
  open_action_count: number;
  actions: FollowUpAction[];
}

interface ExecutiveSummary {
  headline: string;
  decision_prompt: string;
  has_hard_blocker?: boolean;
  hard_blockers?: Risk[];
}

interface ClientProposal {
  sections: {
    cover: { title: string; subtitle: string };
    understanding_your_needs: { points: string[] };
    why_amazon_shipping: { positioning: string; differentiators: string[] };
    commercial_proposal: { selected_scenario: string; scenario: PricingScenario | null };
    next_steps: { points: string[] };
  };
  internal_flags: {
    has_hard_blocker: boolean;
    hard_blockers: CapabilityGap[];
  };
}

interface SourcesUsed {
  challenge_documents: { filename: string; source_type: string }[];
  email_correspondence: { threads: number; messages: number };
  extracted_evidence: { tender_constraints_extracted: number; client_highlights_by_source: Record<string, number> };
  internal_reference_data: Record<string, { total: number; used_by: string[] } | string | null>;
}

interface Dashboard {
  executive_summary: ExecutiveSummary;
  opportunity_score: OpportunityScore;
  win_probability: WinProbability;
  risk_assessment: RiskAssessment;
  commercial_strategy: CommercialStrategy;
  pricing_recommendations: PricingRecommendations;
  follow_up_actions: FollowUpActions;
  client_proposal: ClientProposal;
  sources_used: SourcesUsed;
}

async function callSkill<T>(skill: string, opportunityId: string): Promise<T | null> {
  try {
    const res = await fetch("/api/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill, opportunity_id: opportunityId }),
    });
    const json = await res.json();
    return json.ok ? (json.data as T) : null;
  } catch {
    return null;
  }
}

const severityTone: Record<string, StatusTone> = { high: "danger", medium: "warning", low: "info", none: "success" };
const bandTone: Record<string, StatusTone> = { hot: "success", warm: "warning", cold: "neutral" };
const priorityTone: Record<string, StatusTone> = { high: "danger", medium: "warning", low: "neutral" };
const guardrailTone: Record<string, StatusTone> = {
  within_target: "success",
  above_min_below_target: "info",
  requires_vp_approval: "warning",
  auto_no_go: "danger",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-surface p-5">
      <h3 className="mb-3 text-sm font-bold leading-snug text-ink">{title}</h3>
      <div className="space-y-2 text-sm text-gray-700">{children}</div>
    </div>
  );
}

function EmptyNote({ text }: { text: string }) {
  return <p className="text-xs text-gray-500">{text}</p>;
}

const SKILL_LOAD_ORDER = [
  "executive_summary", "opportunity_score", "win_probability", "risk_assessment",
  "commercial_strategy", "pricing_recommendations", "follow_up_actions", "client_proposal", "sources_used",
] as const;

export default function ExecutiveDashboard() {
  const [opps, setOpps] = useState<OpportunityOption[]>([]);
  const [opportunityId, setOpportunityId] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [progress, setProgress] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    listOpportunitiesForIngestion().then((res) => {
      if (res.ok && res.data && res.data.length > 0) {
        setOpps(res.data);
        setOpportunityId(res.data[0].opportunity_id);
      }
    });
  }, []);

  function loadDashboard() {
    if (!opportunityId) return;
    setDashboard(null);

    startTransition(async () => {
      const results: Record<string, unknown> = {};
      for (const skill of SKILL_LOAD_ORDER) {
        setProgress(skill.replace(/_/g, " "));
        results[skill] = await callSkill(skill, opportunityId);
      }
      setProgress("");
      setDashboard({
        executive_summary: (results.executive_summary as ExecutiveSummary) ?? { headline: "", decision_prompt: "" },
        opportunity_score: (results.opportunity_score as OpportunityScore) ?? { score: 0, band: "cold", rationale: "" },
        win_probability: (results.win_probability as WinProbability) ?? { win_probability: 0, base_rate: 0, top_drivers: [], rationale: "" },
        risk_assessment:
          (results.risk_assessment as RiskAssessment) ?? {
            overall_risk: "none", risk_count: 0, risks: [], has_hard_blocker: false, hard_blockers: [],
          },
        commercial_strategy:
          (results.commercial_strategy as CommercialStrategy) ?? {
            positioning_statement: "", lead_with_strengths: [], address_client_pains: [],
            align_to_priorities: [], objections_to_preempt: [], negotiation_approach: "",
            capability_gaps_to_flag: [], has_hard_blocker: false,
          },
        pricing_recommendations:
          (results.pricing_recommendations as PricingRecommendations) ?? {
            recommended_scenario: "", scenarios: [], guardrails: [], financial_guardrails: null,
          },
        follow_up_actions: (results.follow_up_actions as FollowUpActions) ?? { open_action_count: 0, actions: [] },
        client_proposal:
          (results.client_proposal as ClientProposal) ?? {
            sections: {
              cover: { title: "", subtitle: "" },
              understanding_your_needs: { points: [] },
              why_amazon_shipping: { positioning: "", differentiators: [] },
              commercial_proposal: { selected_scenario: "", scenario: null },
              next_steps: { points: [] },
            },
            internal_flags: { has_hard_blocker: false, hard_blockers: [] },
          },
        sources_used:
          (results.sources_used as SourcesUsed) ?? {
            challenge_documents: [], email_correspondence: { threads: 0, messages: 0 },
            extracted_evidence: { tender_constraints_extracted: 0, client_highlights_by_source: {} },
            internal_reference_data: {},
          },
      });
    });
  }

  const d = dashboard;

  return (
    <section>
      <h2 className="mb-3 text-base font-bold">Executive Dashboard</h2>
      <div className="rounded-md border border-border bg-surface p-4">
        {opps.length === 0 ? (
          <p className="mb-3 text-sm text-gray-500">No opportunities found.</p>
        ) : (
          <div className="mb-3">
            <label htmlFor="dash-opp" className="mb-1 block text-sm font-medium">Opportunity</label>
            <select
              id="dash-opp"
              value={opportunityId}
              onChange={(e) => setOpportunityId(e.target.value)}
              className="h-11 w-full rounded-sm border border-border bg-surface px-2 text-sm"
            >
              {opps.map((o) => (
                <option key={o.opportunity_id} value={o.opportunity_id}>
                  {o.customer_name} — {o.title}
                </option>
              ))}
            </select>
          </div>
        )}

        <button
          onClick={loadDashboard}
          disabled={pending || !opportunityId}
          className="h-11 rounded-sm bg-orange px-4 text-sm font-medium text-ink hover:bg-orange-dark disabled:opacity-60"
        >
          {pending ? `Loading ${progress}…` : "Load dashboard"}
        </button>

        {d ? (
          <div className="mt-5 space-y-5">
            {/* 1. Executive Summary */}
            <div
              className={
                "rounded-md border-2 p-5 text-white " +
                (d.executive_summary.has_hard_blocker ? "border-danger bg-red-950" : "border-ink bg-navy")
              }
            >
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-400">Executive Summary</p>
              {d.executive_summary.has_hard_blocker ? (
                <div className="mb-3 rounded-sm border border-danger bg-danger/20 p-2">
                  <p className="text-xs font-bold uppercase tracking-wide text-red-200">⚠ Hard blocker — Amazon cannot change this</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-red-100">
                    {(d.executive_summary.hard_blockers ?? []).map((r, i) => (
                      <li key={i}>{r.title}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <StatusBadge tone={bandTone[d.opportunity_score.band] ?? "neutral"} label={`${d.opportunity_score.band.toUpperCase()} · ${d.opportunity_score.score}/100`} />
                <StatusBadge tone={severityTone[d.risk_assessment.overall_risk] ?? "neutral"} label={`${d.risk_assessment.overall_risk} risk`} />
                <StatusBadge tone="info" label={`${Math.round(d.win_probability.win_probability * 100)}% win probability`} />
                {d.executive_summary.has_hard_blocker ? <StatusBadge tone="danger" label="HARD BLOCKER" /> : null}
              </div>
              <p className="text-sm font-bold">{d.executive_summary.decision_prompt}</p>
              {d.executive_summary.headline ? <p className="mt-1 text-xs text-gray-300">{d.executive_summary.headline}</p> : null}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              {/* 2. Opportunity Score */}
              <Section title="Opportunity Score">
                <div className="flex items-center gap-3">
                  <span className="text-2xl font-bold text-ink">{d.opportunity_score.score}/100</span>
                  <StatusBadge tone={bandTone[d.opportunity_score.band] ?? "neutral"} label={d.opportunity_score.band} />
                  {d.opportunity_score.has_hard_blocker ? <StatusBadge tone="danger" label="capped: hard blocker" /> : null}
                </div>
                <p className={"text-xs " + (d.opportunity_score.has_hard_blocker ? "font-medium text-danger" : "text-gray-600")}>
                  {d.opportunity_score.rationale}
                </p>
              </Section>

              {/* 8. Win Probability Score */}
              <Section title="Win Probability Score">
                <div className="flex items-center gap-3">
                  <span className="text-2xl font-bold text-ink">{Math.round(d.win_probability.win_probability * 100)}%</span>
                  <span className="text-xs text-gray-500">vs. {Math.round(d.win_probability.base_rate * 100)}% historical base rate</span>
                </div>
                <p className="text-xs text-gray-600">{d.win_probability.rationale}</p>
                {d.win_probability.top_drivers.length > 0 ? (
                  <ul className="space-y-0.5 text-xs">
                    {d.win_probability.top_drivers.map((dr, i) => (
                      <li key={i} className="flex items-center gap-2">
                        <StatusBadge tone={dr.effect >= 0 ? "success" : "danger"} label={dr.effect >= 0 ? "win factor" : "loss factor"} />
                        {dr.factor}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyNote text="No win/loss signals checked yet — probability is the historical base rate." />
                )}
              </Section>

              {/* 3. Risk Assessment */}
              <Section title="Risk Assessment">
                {d.risk_assessment.risks.length === 0 ? (
                  <EmptyNote text="No operational, commercial, or financial risks identified from current data." />
                ) : (
                  <ul className="space-y-1.5">
                    {d.risk_assessment.risks.map((r, i) => (
                      <li
                        key={i}
                        className={
                          "flex items-start gap-2 rounded-sm " +
                          (r.hard_blocker ? "border border-danger bg-danger/10 p-1.5" : "")
                        }
                      >
                        {r.hard_blocker ? <StatusBadge tone="danger" label="HARD BLOCKER" /> : null}
                        <StatusBadge tone={severityTone[r.severity] ?? "neutral"} label={r.category} />
                        <span className={"text-xs " + (r.hard_blocker ? "font-semibold text-danger" : "")}>{r.title}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {/* 6. Required Follow-Up Actions */}
              <Section title="Required Follow-Up Actions">
                {d.follow_up_actions.actions.length === 0 ? (
                  <EmptyNote text="No open questions, meetings, or validations required — clear to proceed." />
                ) : (
                  <ul className="space-y-1.5">
                    {d.follow_up_actions.actions.map((a, i) => {
                      const isHardBlocker = a.type === "hard_blocker_escalation";
                      return (
                        <li
                          key={i}
                          className={
                            "flex items-start gap-2 rounded-sm " +
                            (isHardBlocker ? "border border-danger bg-danger/10 p-1.5" : "")
                          }
                        >
                          {isHardBlocker ? <StatusBadge tone="danger" label="HARD BLOCKER" /> : null}
                          <StatusBadge tone={priorityTone[a.priority] ?? "neutral"} label={a.priority} />
                          <span className={"text-xs " + (isHardBlocker ? "font-semibold text-danger" : "")}>{a.action}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Section>
            </div>

            {/* 4. Pricing Recommendation */}
            <Section title="Pricing Recommendation">
              {d.pricing_recommendations.financial_guardrails ? (
                <p className="text-xs text-gray-500">
                  Guardrails: min {d.pricing_recommendations.financial_guardrails.min_contribution_margin_pct}% · target{" "}
                  {d.pricing_recommendations.financial_guardrails.target_contribution_margin_pct}% · VP approval below{" "}
                  {d.pricing_recommendations.financial_guardrails.vp_approval_required_below_pct}% · auto-no-go below{" "}
                  {d.pricing_recommendations.financial_guardrails.auto_no_go_below_pct}%
                </p>
              ) : null}
              {d.pricing_recommendations.scenarios.length === 0 ? (
                <EmptyNote text="Not enough data to price this opportunity yet." />
              ) : (
                <div className="grid gap-3 md:grid-cols-3">
                  {d.pricing_recommendations.scenarios.map((s) => (
                    <div
                      key={s.name}
                      className={
                        "rounded-sm border p-3 " +
                        (s.name === d.pricing_recommendations.recommended_scenario ? "border-orange bg-orange/10" : "border-border")
                      }
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <p className="text-xs font-bold uppercase text-gray-600">{s.name}</p>
                        {s.guardrail_result ? <StatusBadge tone={guardrailTone[s.guardrail_result] ?? "neutral"} label={s.guardrail_result.replace(/_/g, " ")} /> : null}
                      </div>
                      <p className="mb-1 text-lg font-bold">{s.target_margin_pct}%</p>
                      {s.implied_price_eur ? <p className="mb-2 text-xs text-gray-500">€{s.implied_price_eur.toLocaleString()}</p> : null}
                      <p className="text-xs text-gray-700">{s.rationale}</p>
                      <p className="mt-1 text-xs text-gray-500"><span className="font-medium">Trade-off: </span>{s.tradeoffs}</p>
                      <p className="mt-1 text-xs text-link"><span className="font-medium">Negotiation: </span>{s.negotiation_strategy}</p>
                      {s.floor_note ? <p className="mt-1 text-xs text-warning">{s.floor_note}</p> : null}
                    </div>
                  ))}
                </div>
              )}
              {d.pricing_recommendations.guardrails.map((g, i) => (
                <p key={i} className="text-xs text-warning">{g}</p>
              ))}
            </Section>

            {/* 5. Commercial Strategy */}
            <Section title="Commercial Strategy">
              {d.commercial_strategy.positioning_statement ? (
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <p className="mb-2 text-xs font-medium">{d.commercial_strategy.positioning_statement}</p>
                    {d.commercial_strategy.lead_with_strengths.length > 0 ? (
                      <>
                        <p className="text-xs font-bold text-gray-500">Lead with</p>
                        <ul className="list-disc space-y-0.5 pl-4 text-xs text-gray-600">
                          {d.commercial_strategy.lead_with_strengths.map((s, i) => <li key={i}>{s}</li>)}
                        </ul>
                      </>
                    ) : null}
                    {d.commercial_strategy.objections_to_preempt.length > 0 ? (
                      <>
                        <p className="mt-2 text-xs font-bold text-gray-500">Objections to pre-empt</p>
                        <ul className="list-disc space-y-0.5 pl-4 text-xs text-gray-600">
                          {d.commercial_strategy.objections_to_preempt.map((s, i) => <li key={i}>{s}</li>)}
                        </ul>
                      </>
                    ) : null}
                  </div>
                  <div>
                    {d.commercial_strategy.align_to_priorities.length > 0 ? (
                      <>
                        <p className="text-xs font-bold text-gray-500">Align to client priorities</p>
                        <ul className="list-disc space-y-0.5 pl-4 text-xs text-gray-600">
                          {d.commercial_strategy.align_to_priorities.map((s, i) => <li key={i}>{s}</li>)}
                        </ul>
                      </>
                    ) : null}
                    {d.commercial_strategy.capability_gaps_to_flag.length > 0 ? (
                      <>
                        <p className="mt-2 text-xs font-bold text-danger">Capability gaps to flag with the client</p>
                        <ul className="space-y-1">
                          {d.commercial_strategy.capability_gaps_to_flag.map((g, i) => (
                            <li
                              key={i}
                              className={
                                "flex items-start gap-2 rounded-sm text-xs " +
                                (g.is_hard_blocker ? "border border-danger bg-danger/10 p-1.5" : "")
                              }
                            >
                              {g.is_hard_blocker ? <StatusBadge tone="danger" label="HARD BLOCKER" /> : null}
                              <StatusBadge tone={severityTone[g.severity] ?? "neutral"} label={g.constraint_name} />
                              <span className={g.is_hard_blocker ? "font-medium text-danger" : "text-gray-600"}>{g.gap_description}</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    {d.commercial_strategy.negotiation_approach ? (
                      <p className="mt-2 border-t border-border pt-2 text-xs text-gray-600">
                        <span className="font-medium">Negotiation approach: </span>{d.commercial_strategy.negotiation_approach}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : (
                <EmptyNote text="Not enough client/competitive data yet to recommend a strategy." />
              )}
            </Section>

            {/* 7. Client Proposal / Pitch Deck */}
            <div className="rounded-md border-2 border-orange bg-surface p-5">
              <p className="mb-3 text-xs font-bold uppercase tracking-wide text-orange-dark">Client Proposal / Pitch Deck</p>
              <p className="mb-1 text-base font-bold text-ink">{d.client_proposal.sections.cover.title}</p>
              <p className="mb-3 text-xs text-gray-500">{d.client_proposal.sections.cover.subtitle}</p>
              {d.client_proposal.internal_flags.has_hard_blocker ? (
                <div className="mb-3 rounded-sm border border-danger bg-danger/10 p-2">
                  <p className="text-xs font-bold uppercase tracking-wide text-danger">
                    ⚠ Internal only — do not promise these in the deck
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-danger">
                    {d.client_proposal.internal_flags.hard_blockers.map((g, i) => (
                      <li key={i}>{g.constraint_name}: {g.gap_description}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <p className="text-xs font-bold text-gray-500">What we heard from you</p>
                  <ul className="list-disc space-y-0.5 pl-4 text-xs text-gray-700">
                    {d.client_proposal.sections.understanding_your_needs.points.map((p, i) => <li key={i}>{p}</li>)}
                  </ul>
                </div>
                <div>
                  <p className="text-xs font-bold text-gray-500">Why Amazon Shipping</p>
                  <p className="text-xs text-gray-700">{d.client_proposal.sections.why_amazon_shipping.positioning}</p>
                  {d.client_proposal.sections.commercial_proposal.scenario ? (
                    <p className="mt-2 text-xs text-gray-700">
                      <span className="font-medium">Proposed pricing ({d.client_proposal.sections.commercial_proposal.selected_scenario}): </span>
                      {d.client_proposal.sections.commercial_proposal.scenario.target_margin_pct}% margin
                    </p>
                  ) : null}
                  {d.client_proposal.sections.next_steps.points.length > 0 ? (
                    <>
                      <p className="mt-2 text-xs font-bold text-gray-500">Next steps</p>
                      <ul className="list-disc space-y-0.5 pl-4 text-xs text-gray-700">
                        {d.client_proposal.sections.next_steps.points.map((p, i) => <li key={i}>{p}</li>)}
                      </ul>
                    </>
                  ) : null}
                </div>
              </div>
            </div>

            {/* 9. Sources Used */}
            <Section title="Sources Used">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <p className="text-xs font-bold text-gray-500">Opportunity-specific evidence</p>
                  {d.sources_used.challenge_documents.length === 0 ? (
                    <EmptyNote text="No documents ingested yet." />
                  ) : (
                    <ul className="space-y-0.5 text-xs text-gray-700">
                      {d.sources_used.challenge_documents.map((doc, i) => (
                        <li key={i}>{doc.filename} <span className="text-gray-400">({doc.source_type})</span></li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-2 text-xs text-gray-600">
                    {d.sources_used.email_correspondence.messages} email(s) across {d.sources_used.email_correspondence.threads} thread(s) ·{" "}
                    {d.sources_used.extracted_evidence.tender_constraints_extracted} constraint(s) extracted
                  </p>
                </div>
                <div>
                  <p className="text-xs font-bold text-gray-500">Internal reference data used</p>
                  <ul className="space-y-0.5 text-xs text-gray-600">
                    {Object.entries(d.sources_used.internal_reference_data).map(([key, val]) => {
                      if (!val || typeof val === "string") return null;
                      return (
                        <li key={key}>
                          {key.replace(/_/g, " ")}: {val.total} row(s) — used by {val.used_by.join(", ")}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            </Section>
          </div>
        ) : null}
      </div>
    </section>
  );
}
