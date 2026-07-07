"use client";

import { useState } from "react";
import StatusBadge from "@/components/StatusBadge";

// Historical Insights — PCA + KMeans analysis over core.historical_tenders
// (skills/exploration/historical_archetypes.py), surfaced as: correlated
// features, PCA loadings, empirical win-rate "archetypes", and actionable
// insights. Running the analysis also (optionally) pickles the fitted
// pipeline for download and (re)writes the auto-generated findings section
// of RETRIEVAL_REQUIREMENTS.md — the doc that maps skill -> field -> origin
// for the retrieval engine.

interface CorrelationPair {
  a: string;
  b: string;
  r: number;
}

interface PcaLoading {
  feature: string;
  loading: number;
}

interface PcaComponent {
  pc: number;
  top_loadings: PcaLoading[];
}

interface PcaSummary {
  explained_variance_ratio: number[];
  cumulative_variance: number;
  components: PcaComponent[];
}

interface FeatureProfileEntry {
  feature: string;
  value: number;
}

interface Archetype {
  cluster: number;
  n: number;
  win_rate: number;
  avg_margin: number | null;
  top_pain_point: string | null;
  feature_profile: FeatureProfileEntry[];
}

interface HistoricalAnalysis {
  n_total: number;
  n_won: number;
  n_lost: number;
  correlations: CorrelationPair[];
  pca_summary: PcaSummary;
  archetypes: Archetype[];
  insights: string[];
  model_path: string | null;
  requirements_doc_updated: boolean;
  error?: string;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-surface p-5">
      <h3 className="mb-3 text-sm font-bold leading-snug text-ink">{title}</h3>
      <div className="space-y-2 text-sm text-gray-700">{children}</div>
    </div>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-sm border border-border bg-surface p-3">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-xl font-bold text-ink">{value}</span>
        {sub ? <span className="text-xs text-gray-500">{sub}</span> : null}
      </div>
    </div>
  );
}

export default function HistoricalInsightsDashboard() {
  const [data, setData] = useState<HistoricalAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clusters, setClusters] = useState(4);

  async function runAnalysis() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/historical-insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clusters,
          save_model: true,
          update_requirements_doc: true,
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "Analysis failed.");
        return;
      }
      if (json.data.error) {
        setError(json.data.error);
        return;
      }
      setData(json.data as HistoricalAnalysis);
    } catch {
      setError("Could not reach the analysis service.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-surface p-4">
        <div>
          <label htmlFor="clusters" className="mb-1 block text-xs font-medium text-gray-500">
            Number of archetypes (clusters)
          </label>
          <input
            id="clusters"
            type="number"
            min={2}
            max={8}
            value={clusters}
            onChange={(e) => setClusters(Number(e.target.value))}
            className="h-11 w-24 rounded-sm border border-border bg-surface px-2 text-sm"
          />
        </div>
        <button
          onClick={runAnalysis}
          disabled={loading}
          className="h-11 rounded-sm bg-orange px-4 text-sm font-medium text-ink hover:bg-orange-dark disabled:opacity-60"
        >
          {loading ? "Running…" : "Run analysis"}
        </button>
        {data?.model_path ? (
          <a
            href="/api/historical-insights/model"
            className="h-11 rounded-sm border border-border bg-surface px-4 text-sm font-medium text-ink hover:bg-canvas flex items-center"
          >
            Download model (.joblib) →
          </a>
        ) : null}
        {data?.requirements_doc_updated ? (
          <StatusBadge tone="success" label="RETRIEVAL_REQUIREMENTS.md updated" />
        ) : null}
      </div>

      {error ? (
        <div className="rounded-md border border-danger/30 bg-red-50 p-4 text-sm text-danger">{error}</div>
      ) : null}

      {!data && !loading && !error ? (
        <p className="text-sm text-gray-500">
          Run the analysis to see feature correlations, PCA-driven opportunity archetypes,
          and actionable insights from the 360 historical tenders.
        </p>
      ) : null}

      {data && !data.error ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Historical tenders" value={String(data.n_total)} />
            <StatTile label="Won" value={String(data.n_won)} />
            <StatTile label="Lost" value={String(data.n_lost)} />
            <StatTile
              label="Overall win rate"
              value={data.n_total ? `${Math.round((data.n_won / data.n_total) * 100)}%` : "—"}
            />
          </div>

          <Section title="Actionable insights">
            <ul className="list-disc space-y-2 pl-5">
              {data.insights.map((insight, i) => (
                <li key={i}>{insight}</li>
              ))}
            </ul>
          </Section>

          <Section title="Opportunity archetypes (KMeans clusters)">
            <div className="grid gap-3 md:grid-cols-2">
              {data.archetypes.map((a) => (
                <div key={a.cluster} className="rounded-sm border border-border p-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-medium text-ink">Archetype {a.cluster}</span>
                    <StatusBadge
                      tone={a.win_rate >= 0.55 ? "success" : a.win_rate >= 0.4 ? "warning" : "danger"}
                      label={`${Math.round(a.win_rate * 100)}% win rate`}
                    />
                  </div>
                  <p className="text-xs text-gray-500">
                    n={a.n}
                    {a.avg_margin != null ? ` · avg margin ${(a.avg_margin * 100).toFixed(1)}%` : ""}
                  </p>
                  {a.top_pain_point ? (
                    <p className="mt-1 text-xs">
                      Top pain point: <span className="font-medium">{a.top_pain_point}</span>
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-gray-500">
                    {a.feature_profile.map((fp) => `${fp.feature}=${fp.value.toFixed(2)}`).join(" · ")}
                  </p>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Feature correlations (|r| ≥ 0.3)">
            {data.correlations.length === 0 ? (
              <p className="text-gray-400">No pairs at this threshold — features are largely independent.</p>
            ) : (
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase text-gray-500">
                    <th className="py-1 pr-2">Feature A</th>
                    <th className="py-1 pr-2">Feature B</th>
                    <th className="py-1">r</th>
                  </tr>
                </thead>
                <tbody>
                  {data.correlations.map((p, i) => (
                    <tr key={i} className="border-b border-border last:border-0">
                      <td className="py-1 pr-2">{p.a}</td>
                      <td className="py-1 pr-2">{p.b}</td>
                      <td className="py-1 font-medium">{p.r > 0 ? "+" : ""}{p.r.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="PCA — which features drive variance">
            <p className="text-xs text-gray-500">
              Cumulative variance explained by {data.pca_summary.components.length} components:{" "}
              {Math.round(data.pca_summary.cumulative_variance * 100)}%
            </p>
            <div className="grid gap-3 md:grid-cols-3">
              {data.pca_summary.components.map((c) => (
                <div key={c.pc} className="rounded-sm border border-border p-3">
                  <p className="mb-1 text-xs font-medium text-gray-500">
                    PC{c.pc} ({Math.round(data.pca_summary.explained_variance_ratio[c.pc - 1] * 100)}% variance)
                  </p>
                  <ul className="space-y-0.5 text-xs">
                    {c.top_loadings.map((l) => (
                      <li key={l.feature} className="flex justify-between gap-2">
                        <span>{l.feature}</span>
                        <span className="font-medium">{l.loading > 0 ? "+" : ""}{l.loading.toFixed(2)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Section>
        </>
      ) : null}
    </div>
  );
}
