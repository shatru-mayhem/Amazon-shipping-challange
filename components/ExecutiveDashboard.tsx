"use client";

import { useEffect, useState, useTransition } from "react";
import StatusBadge from "@/components/StatusBadge";
import { listOpportunitiesForIngestion, type OpportunityOption } from "@/app/actions/tender_ingestion";

// Executive-facing view of the whole flow (flow.jpeg): every one of the
// 8 skills that feed the final decision, in one place, for one
// opportunity. Executive summary first (the decision prompt an exec
// actually wants), supporting detail below it.

interface SkillResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

async function callSkill(skill: string, opportunityId: string, extraArgs?: string[]): Promise<SkillResult> {
  try {
    const res = await fetch("/api/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill, opportunity_id: opportunityId, extra_args: extraArgs }),
    });
    const json = await res.json();
    if (!json.ok) return { ok: false, error: json.error };
    return { ok: true, data: json.data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Request failed." };
  }
}

const SKILL_ORDER = [
  { key: "executive_summary", label: "Executive Summary" },
  { key: "opportunity_score", label: "Opportunity Score" },
  { key: "win_probability", label: "Win Probability" },
  { key: "risk_assessment", label: "Risk Assessment" },
  { key: "commercial_strategy", label: "Commercial Strategy" },
  { key: "pricing_recommendations", label: "Pricing Recommendations" },
  { key: "client_proposal", label: "Client Proposal & Pitch Deck" },
  { key: "follow_up_actions", label: "Follow-up Actions (Zapier)" },
] as const;

export default function ExecutiveDashboard() {
  const [opps, setOpps] = useState<OpportunityOption[]>([]);
  const [opportunityId, setOpportunityId] = useState("");
  const [results, setResults] = useState<Record<string, SkillResult>>({});
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
    setResults({});

    startTransition(async () => {
      const collected: Record<string, SkillResult> = {};
      for (const s of SKILL_ORDER) {
        setProgress(s.label);
        collected[s.key] = await callSkill(s.key, opportunityId);
        setResults({ ...collected });
      }
      setProgress("");
    });
  }

  return (
    <section>
      <h2 className="mb-3 text-base font-bold">Executive Dashboard</h2>
      <div className="rounded-sm border border-border bg-surface p-4">
        {opps.length === 0 ? (
          <p className="mb-3 text-sm text-gray-500">No opportunities found.</p>
        ) : (
          <div className="mb-3">
            <label htmlFor="dash-opp" className="mb-1 block text-sm font-medium">
              Opportunity
            </label>
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

        <div className="mt-4 space-y-4 border-t border-border pt-4">
          {SKILL_ORDER.map(({ key, label }) => {
            const result = results[key];
            if (!result) return null;
            return (
              <div key={key} className="rounded-sm border border-border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-bold">{label}</h3>
                  <StatusBadge tone={result.ok ? "success" : "danger"} label={result.ok ? "loaded" : "error"} />
                </div>
                {result.ok ? (
                  <pre className="overflow-x-auto text-xs text-gray-700">
                    {JSON.stringify(result.data, null, 2)}
                  </pre>
                ) : (
                  <p className="text-xs text-danger">{result.error}</p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
