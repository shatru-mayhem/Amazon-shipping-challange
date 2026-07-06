"use client";

import { useEffect, useState } from "react";
import StatusBadge, { type StatusTone } from "@/components/StatusBadge";

// Software analytics — real tokenomics/latency telemetry for every LLM
// call the pipeline has made (skills/_llm.py logs each embed()/
// generate_json() call to observability.llm_call_log; see
// skills/software_analytics). Not opportunity-scoped: this is the
// pipeline's own operating data, not a client deliverable.
//
// Palette: brand tokens (orange/link/success/warning/danger) failed the
// dataviz skill's categorical validator (chroma floor, CVD separation —
// see skill invocation this session), so the "by skill" chart uses the
// skill's validated default categorical ramp instead, in a fixed order
// per entity (never re-derived from data order). Status (success/failed)
// uses the skill's fixed status palette, which is deliberately distinct
// from the categorical slots.

interface BySkill {
  skill: string;
  call_count: number;
  total_tokens: number;
  avg_latency_ms: number | null;
  failed_calls: number;
}

interface ByModel {
  model: string;
  call_type: "embed" | "generate_json";
  is_cloud: boolean;
  call_count: number;
  total_tokens: number;
  avg_latency_ms: number | null;
}

interface RecentCall {
  skill: string | null;
  call_type: "embed" | "generate_json";
  model: string;
  is_cloud: boolean;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  total_duration_ms: number | null;
  success: boolean;
  error_message: string | null;
  created_at: string;
}

interface TimelinePoint {
  created_at: string;
  call_type: "embed" | "generate_json";
  skill: string | null;
  total_duration_ms: number;
  total_tokens: number | null;
  success: boolean;
}

interface SoftwareAnalytics {
  total_calls: number;
  success_rate: number | null;
  failed_calls: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  avg_latency_ms: number | null;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  cloud_calls: number;
  local_calls: number;
  by_skill: BySkill[];
  by_model: ByModel[];
  recent_calls: RecentCall[];
  latency_timeline: TimelinePoint[];
  cost_note: string;
}

// Fixed categorical order — dataviz skill's validated default palette,
// slots assigned once per known entity so a filter or new skill entering
// the data never repaints an existing bar's color.
const SKILL_COLORS: Record<string, string> = {
  opportunity_features: "#2a78d6", // blue
  tender_constraints: "#1baf7a", // aqua
  client_highlights: "#eda100", // yellow
  email_messages: "#008300", // green
  capability_ingestion: "#4a3aa7", // violet
};
const OTHER_COLOR = "#898781"; // muted ink — "unattributed"/overflow, not a hue

const STATUS = {
  good: "#0ca30c",
  critical: "#d03b3b",
};

function skillColor(skill: string): string {
  return SKILL_COLORS[skill] ?? OTHER_COLOR;
}

function skillLabel(skill: string): string {
  return skill === "unattributed" ? "unattributed (internal)" : skill.replace(/_/g, " ");
}

async function callGlobalSkill<T>(skill: string): Promise<T | null> {
  try {
    const res = await fetch("/api/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill }),
    });
    const json = await res.json();
    return json.ok ? (json.data as T) : null;
  } catch {
    return null;
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-surface p-5">
      <h3 className="mb-3 text-sm font-bold leading-snug text-ink">{title}</h3>
      <div className="space-y-2 text-sm text-gray-700">{children}</div>
    </div>
  );
}

function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: StatusTone }) {
  return (
    <div className="rounded-sm border border-border bg-surface p-3">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-xl font-bold text-ink">{value}</span>
        {tone ? <StatusBadge tone={tone} label={sub ?? ""} /> : sub ? <span className="text-xs text-gray-500">{sub}</span> : null}
      </div>
    </div>
  );
}

// Horizontal bar chart, categorical — one bar per skill, direct-labeled
// (name + count at the bar's end), so no separate legend box is needed:
// the label IS the identification. Thin marks (10px), 4px rounded end,
// 6px gap between bars.
function CallsBySkillChart({ rows }: { rows: BySkill[] }) {
  if (rows.length === 0) return <EmptyNote text="No LLM calls logged yet." />;
  const max = Math.max(...rows.map((r) => r.call_count), 1);
  const [hover, setHover] = useState<number | null>(null);

  return (
    <div className="space-y-2">
      {rows.map((r, i) => {
        const widthPct = Math.max((r.call_count / max) * 100, 3);
        const color = skillColor(r.skill);
        return (
          <div
            key={r.skill}
            className="relative"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <div className="mb-0.5 flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 font-medium text-ink">
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
                {skillLabel(r.skill)}
              </span>
              <span className="text-gray-500">
                {r.call_count} call{r.call_count === 1 ? "" : "s"} · {r.total_tokens.toLocaleString()} tok
                {r.failed_calls > 0 ? ` · ${r.failed_calls} failed` : ""}
              </span>
            </div>
            <div className="h-2.5 w-full rounded-full bg-canvas">
              <div
                className="h-2.5 rounded-full transition-[width]"
                style={{ width: `${widthPct}%`, backgroundColor: color }}
              />
            </div>
            {hover === i ? (
              <div className="absolute left-0 top-full z-10 mt-1 rounded-sm border border-border bg-surface px-2 py-1 text-xs shadow-md">
                {skillLabel(r.skill)}: {r.call_count} calls, avg {r.avg_latency_ms ?? "—"} ms
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// Per-call latency timeline — thin vertical bars in chronological order,
// 4px rounded top, 2px surface gap between bars. Color encodes status
// (good/critical), not identity, so it draws from the fixed status
// palette rather than the categorical one.
function LatencyTimelineChart({ points }: { points: TimelinePoint[] }) {
  if (points.length === 0) return <EmptyNote text="No latency data yet." />;
  const max = Math.max(...points.map((p) => p.total_duration_ms), 1);
  const [hover, setHover] = useState<number | null>(null);
  const barWidth = Math.max(Math.min(400 / points.length, 18) - 2, 3);

  return (
    <div>
      <div className="mb-2 flex items-center gap-3 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: STATUS.good }} />success</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: STATUS.critical }} />failed</span>
        <span className="ml-auto">latest {points.length} calls, chronological →</span>
      </div>
      <div className="relative flex h-32 items-end gap-[2px] overflow-x-auto border-b border-border pb-0.5">
        {points.map((p, i) => {
          const heightPct = Math.max((p.total_duration_ms / max) * 100, 2);
          return (
            <div
              key={i}
              className="relative shrink-0 cursor-default rounded-t-sm"
              style={{
                width: `${barWidth}px`,
                height: `${heightPct}%`,
                backgroundColor: p.success ? STATUS.good : STATUS.critical,
                opacity: p.success ? 0.75 : 0.9,
              }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              {hover === i ? (
                <div className="absolute bottom-full left-1/2 z-10 mb-1 w-max -translate-x-1/2 rounded-sm border border-border bg-surface px-2 py-1 text-xs shadow-md">
                  <p className="font-medium text-ink">{p.total_duration_ms.toFixed(0)} ms</p>
                  <p className="text-gray-500">{p.call_type} · {p.skill ? skillLabel(p.skill) : "unattributed"}</p>
                  {p.total_tokens ? <p className="text-gray-500">{p.total_tokens} tokens</p> : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EmptyNote({ text }: { text: string }) {
  return <p className="text-xs text-gray-500">{text}</p>;
}

export default function SoftwareAnalyticsDashboard() {
  const [data, setData] = useState<SoftwareAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    callGlobalSkill<SoftwareAnalytics>("software_analytics").then((res) => {
      setLoading(false);
      if (!res) {
        setError("Could not load software analytics.");
        return;
      }
      setData(res);
    });
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-bold">Software Analytics</h2>
        <button
          onClick={load}
          disabled={loading}
          className="h-9 rounded-sm border border-border bg-surface px-3 text-xs font-medium text-ink hover:bg-canvas disabled:opacity-60"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      <p className="mb-4 text-xs text-gray-500">
        Real telemetry from every LLM call the pipeline has made (not mock data) — token usage and latency logged by
        skills/_llm.py to observability.llm_call_log.
      </p>

      {error ? <EmptyNote text={error} /> : null}

      {data ? (
        <div className="space-y-5">
          {data.total_calls === 0 ? (
            <EmptyNote text="No LLM calls logged yet — run the pipeline (upload a tender, then persist.py) to generate telemetry." />
          ) : null}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
            <StatTile label="Total calls" value={data.total_calls.toLocaleString()} />
            <StatTile
              label="Success rate"
              value={data.success_rate !== null ? `${Math.round(data.success_rate * 100)}%` : "—"}
              sub={data.failed_calls > 0 ? `${data.failed_calls} failed` : "all succeeded"}
              tone={data.failed_calls > 0 ? "warning" : "success"}
            />
            <StatTile label="Total tokens" value={data.total_tokens.toLocaleString()} sub={`${data.total_prompt_tokens.toLocaleString()} in / ${data.total_completion_tokens.toLocaleString()} out`} />
            <StatTile label="Avg latency" value={data.avg_latency_ms !== null ? `${Math.round(data.avg_latency_ms)} ms` : "—"} />
            <StatTile label="P95 latency" value={data.p95_latency_ms !== null ? `${Math.round(data.p95_latency_ms)} ms` : "—"} sub={data.p50_latency_ms !== null ? `p50 ${Math.round(data.p50_latency_ms)} ms` : undefined} />
            <StatTile label="Cloud / local" value={`${data.cloud_calls} / ${data.local_calls}`} sub="calls" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Calls by skill">
              <CallsBySkillChart rows={data.by_skill} />
            </Section>

            <Section title="Latency timeline (per call)">
              <LatencyTimelineChart points={data.latency_timeline} />
            </Section>
          </div>

          <Section title="By model">
            {data.by_model.length === 0 ? (
              <EmptyNote text="No calls logged yet." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border text-gray-500">
                      <th className="py-1.5 pr-3 font-medium">Model</th>
                      <th className="py-1.5 pr-3 font-medium">Call type</th>
                      <th className="py-1.5 pr-3 font-medium">Source</th>
                      <th className="py-1.5 pr-3 font-medium">Calls</th>
                      <th className="py-1.5 pr-3 font-medium">Tokens</th>
                      <th className="py-1.5 pr-3 font-medium">Avg latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_model.map((m, i) => (
                      <tr key={i} className="border-b border-border last:border-0">
                        <td className="py-1.5 pr-3">{m.model}</td>
                        <td className="py-1.5 pr-3">{m.call_type}</td>
                        <td className="py-1.5 pr-3">
                          <StatusBadge tone={m.is_cloud ? "info" : "neutral"} label={m.is_cloud ? "cloud" : "local"} />
                        </td>
                        <td className="py-1.5 pr-3">{m.call_count}</td>
                        <td className="py-1.5 pr-3">{m.total_tokens > 0 ? m.total_tokens.toLocaleString() : "—"}</td>
                        <td className="py-1.5 pr-3">{m.avg_latency_ms !== null ? `${Math.round(m.avg_latency_ms)} ms` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-xs text-gray-500">{data.cost_note}</p>
          </Section>

          <Section title="Recent calls">
            {data.recent_calls.length === 0 ? (
              <EmptyNote text="No calls logged yet." />
            ) : (
              <div className="max-h-80 overflow-y-auto">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="border-b border-border text-gray-500">
                      <th className="py-1.5 pr-3 font-medium">Time</th>
                      <th className="py-1.5 pr-3 font-medium">Skill</th>
                      <th className="py-1.5 pr-3 font-medium">Type</th>
                      <th className="py-1.5 pr-3 font-medium">Tokens</th>
                      <th className="py-1.5 pr-3 font-medium">Latency</th>
                      <th className="py-1.5 pr-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent_calls.map((c, i) => (
                      <tr key={i} className="border-b border-border last:border-0">
                        <td className="py-1.5 pr-3 text-gray-500">{new Date(c.created_at).toLocaleString()}</td>
                        <td className="py-1.5 pr-3">
                          <span className="flex items-center gap-1.5">
                            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: skillColor(c.skill ?? "unattributed") }} />
                            {c.skill ? skillLabel(c.skill) : "unattributed"}
                          </span>
                        </td>
                        <td className="py-1.5 pr-3">{c.call_type}</td>
                        <td className="py-1.5 pr-3">{c.total_tokens ?? "—"}</td>
                        <td className="py-1.5 pr-3">{c.total_duration_ms !== null ? `${Math.round(c.total_duration_ms)} ms` : "—"}</td>
                        <td className="py-1.5 pr-3">
                          {c.success ? (
                            <StatusBadge tone="success" label="ok" />
                          ) : (
                            <StatusBadge tone="danger" label="failed" />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </div>
      ) : !error ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : null}
    </section>
  );
}
