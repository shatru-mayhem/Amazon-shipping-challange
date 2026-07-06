"use client";

import { useEffect, useState, useTransition } from "react";
import StatusBadge from "@/components/StatusBadge";
import { listOpportunitiesForIngestion, type OpportunityOption } from "@/app/actions/tender_ingestion";

// Closes the loop from RETRIEVAL_REQUIREMENTS.md: once tender/email data
// has been ingested, this asks retrieval.py (via /api/retrieve) for
// exactly what the downstream skills need and reports back what it
// found — found or not_found, every time, never silent.

const OPPORTUNITY_FEATURE_FIELDS = [
  "volume",
  "geography",
  "industry_vertical",
  "contract_length_months",
  "required_sla_hours",
  "incumbent_provider",
  "requested_discount_pct",
];

interface RetrievalResult {
  table: string;
  field: string | null;
  status: "found" | "not_found" | "error";
  value?: unknown;
  reason?: string;
}

async function callRetrieve(opportunityId: string, table: string, field?: string): Promise<RetrievalResult> {
  try {
    const res = await fetch("/api/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opportunity_id: opportunityId, table, field }),
    });
    const json = await res.json();
    if (!json.ok) return { table, field: field ?? null, status: "error", reason: json.error };
    return { table, field: field ?? null, ...json.data };
  } catch (e) {
    return { table, field: field ?? null, status: "error", reason: e instanceof Error ? e.message : "Request failed." };
  }
}

export default function RetrievalStatusPanel() {
  const [opps, setOpps] = useState<OpportunityOption[]>([]);
  const [opportunityId, setOpportunityId] = useState("");
  const [results, setResults] = useState<RetrievalResult[]>([]);
  const [progress, setProgress] = useState<string>("");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    listOpportunitiesForIngestion().then((res) => {
      if (res.ok && res.data && res.data.length > 0) {
        setOpps(res.data);
        setOpportunityId(res.data[0].opportunity_id);
      }
    });
  }, []);

  function runRetrieval() {
    if (!opportunityId) return;
    setResults([]);

    startTransition(async () => {
      const collected: RetrievalResult[] = [];

      for (const field of OPPORTUNITY_FEATURE_FIELDS) {
        setProgress(`opportunity_features.${field}`);
        collected.push(await callRetrieve(opportunityId, "opportunity_features", field));
      }
      setProgress("tender_constraints");
      collected.push(await callRetrieve(opportunityId, "tender_constraints"));
      setProgress("client_highlights");
      collected.push(await callRetrieve(opportunityId, "client_highlights"));
      setProgress("email_messages");
      collected.push(await callRetrieve(opportunityId, "email_messages"));

      setProgress("");
      setResults(collected);
    });
  }

  return (
    <section>
      <h2 className="mb-3 text-base font-bold">Retrieval Status</h2>
      <div className="rounded-sm border border-border bg-surface p-4">
        {opps.length === 0 ? (
          <p className="mb-3 text-sm text-gray-500">No opportunities found.</p>
        ) : (
          <div className="mb-3">
            <label htmlFor="retrieval-opp" className="mb-1 block text-sm font-medium">
              Opportunity
            </label>
            <select
              id="retrieval-opp"
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
          onClick={runRetrieval}
          disabled={pending || !opportunityId}
          className="h-11 rounded-sm bg-orange px-4 text-sm font-medium text-ink hover:bg-orange-dark disabled:opacity-60"
        >
          {pending ? `Retrieving ${progress}…` : "Check what's retrievable now"}
        </button>

        {results.length > 0 ? (
          <ul className="mt-4 space-y-2 border-t border-border pt-4">
            {results.map((r, i) => (
              <li key={i} className="rounded-sm border border-border p-2.5 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {r.table}
                    {r.field ? `.${r.field}` : ""}
                  </span>
                  <StatusBadge
                    tone={r.status === "found" ? "success" : r.status === "not_found" ? "warning" : "danger"}
                    label={r.status}
                  />
                </div>
                {r.status === "found" ? (
                  <pre className="mt-1 overflow-x-auto text-xs text-gray-600">
                    {JSON.stringify(r.value, null, 2)}
                  </pre>
                ) : (
                  <p className="mt-1 text-xs text-gray-500">{r.reason}</p>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
