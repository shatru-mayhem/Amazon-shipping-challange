"use client";

// Port of dashboard_with_figmaMake/src/app/App.tsx into the real Next.js
// app, wired to live data instead of MOCK_DASHBOARD. Visual design is kept
// as close to the prototype as possible (same layout, same brand tokens,
// same chat/nav/panel structure) — see FIGMA_DASHBOARD_BACKEND_MAPPING.md
// for the field-by-field mapping this rewrite follows.
//
// Known gap carried over from the mapping report: Employee Mode's flow
// diagram is still visual/decorative (status values are illustrative, not
// polled from real retrieval/ingestion state) — wiring that up is a
// separate follow-up, not done here.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Inbox, BarChart2, FileText, DollarSign, Briefcase, CheckSquare, Presentation,
  Target, BookOpen, Send, Upload, Mail, RefreshCw, Database, ChevronDown,
  AlertTriangle, CheckCircle, Loader2, AlertCircle, ArrowDown, CircleCheck,
  CircleDot, Circle, MessageCircle,
} from "lucide-react";
import { listOpportunitiesForIngestion, listTenderDocuments, type OpportunityOption } from "@/app/actions/tender_ingestion";
import { listEmailThreads } from "@/app/actions/email_ingestion";
import type { CoreDocument, CoreEmailThread } from "@/lib/db-types";
import type {
  Dashboard,
  ExecutiveSummary,
  OpportunityScore,
  WinProbability,
  RiskAssessment,
  CommercialStrategy,
  PricingRecommendations,
  CalculationStep,
  FollowUpActions,
  ClientProposal,
  SourcesUsed,
} from "@/lib/dashboard-types";
import RealPitchDeckPanel from "@/components/PitchDeckPanel";

// ─── Brand tokens (match tailwind.config.ts exactly) ──────────────────────
const C = {
  ink: "#131A22",
  navy: "#232F3E",
  orange: "#FF9900",
  orangeDark: "#E88B00",
  link: "#007185",
  surface: "#FFFFFF",
  canvas: "#F3F4F6",
  border: "#D5D9D9",
  success: "#067D62",
  warning: "#B45309",
  danger: "#B12704",
  muted: "#6B7280",
};

// ─── Real data fetch (same bridge ExecutiveDashboard.tsx uses) ─────────────
const SKILL_LOAD_ORDER = [
  "executive_summary", "opportunity_score", "win_probability", "risk_assessment",
  "commercial_strategy", "pricing_recommendations", "follow_up_actions", "client_proposal", "sources_used",
] as const;

async function callSkill<T>(
  skill: string,
  opportunityId: string,
  extraArgs?: string[],
  onError?: (skill: string, message: string) => void,
): Promise<T | null> {
  try {
    const res = await fetch("/api/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill, opportunity_id: opportunityId, extra_args: extraArgs }),
    });
    const json = await res.json().catch(() => ({ ok: false, error: res.status + " " + res.statusText }));
    if (!json.ok) onError?.(skill, json.error ?? "unknown error");
    return json.ok ? (json.data as T) : null;
  } catch (e) {
    onError?.(skill, e instanceof Error ? e.message : "network error");
    return null;
  }
}

// ─── Shared utilities ───────────────────────────────────────────────────────
type Tone = "success" | "warning" | "danger" | "info" | "neutral";

function StatusBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const colors: Record<Tone, string> = {
    success: "bg-emerald-50 text-emerald-800 border-emerald-200",
    warning: "bg-amber-50 text-amber-800 border-amber-200",
    danger: "bg-red-50 text-red-800 border-red-200",
    info: "bg-cyan-50 text-cyan-800 border-cyan-200",
    neutral: "bg-gray-50 text-gray-700 border-gray-200",
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-sm font-medium border ${colors[tone]}`}>
      {children}
    </span>
  );
}

function Card({ children, className = "", style = {} }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={`bg-white rounded-lg border p-5 ${className}`} style={{ borderColor: C.border, ...style }}>
      {children}
    </div>
  );
}

const guardrailTone = (g?: string): Tone =>
  g === "within_target" ? "success" : g === "auto_no_go" ? "danger" : "warning";

// ─── Persistent chat panel — backed by nl_query_gemini.py via /api/chat ───
const SUGGESTED_QUESTIONS: Record<string, string[]> = {
  "Executive Summary": ["What's the key risk here?", "Is this deal worth pursuing?"],
  "Opportunity Score": ["Why is the score what it is?", "What would move this to 'hot'?"],
  "Risk Assessment": ["How serious is the top risk?", "What mitigation is recommended?"],
  "Pricing Recommendation": ["Why is this scenario recommended?", "What's the guardrail floor?"],
  "Commercial Strategy": ["How do we handle the capability gap?", "Top objection to prepare for?"],
  "Required Follow-Up Actions": ["Which action is most urgent?", "What's still open?"],
  "Client Proposal / Pitch Deck": ["What's on the pricing slide?", "Is the deck ready to send?"],
  "Win Probability Score": ["What's driving this number?", "How do we close the gap?"],
  "Ingestion Pipeline": ["What's the current pipeline status?", "Any documents still queued?"],
};

type ChatMessage = { role: "user" | "assistant" | "error"; text: string; sql?: string; rowCount?: number };

function ChatPanel({ context }: { context: string }) {
  const [threads, setThreads] = useState<Record<string, ChatMessage[]>>({});
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messages = threads[context] ?? [];
  const suggested = SUGGESTED_QUESTIONS[context] ?? ["Ask anything about this view.", "What should I focus on?"];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, typing, context]);

  const send = (text: string) => {
    if (!text.trim()) return;
    const userMsg: ChatMessage = { role: "user", text };
    setThreads((prev) => ({ ...prev, [context]: [...(prev[context] ?? []), userMsg] }));
    setInput("");
    setTyping(true);
    (async () => {
      let reply: ChatMessage;
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: text }),
        });
        const json = await res.json();
        if (json.ok) {
          reply = { role: "assistant", text: json.data.answer, sql: json.data.sql, rowCount: json.data.row_count };
        } else {
          reply = { role: "error", text: json.error ?? "Could not get an answer." };
        }
      } catch {
        reply = { role: "error", text: "Could not reach the chat service." };
      }
      setThreads((prev) => ({ ...prev, [context]: [...(prev[context] ?? []), reply] }));
      setTyping(false);
    })();
  };

  return (
    <div className="flex flex-col h-full" style={{ background: C.surface }}>
      <div className="px-4 py-3 border-b flex-shrink-0" style={{ borderColor: C.border, background: C.navy }}>
        <div className="flex items-center gap-2">
          <MessageCircle size={15} style={{ color: C.orange }} />
          <span className="text-sm font-semibold text-white truncate">Ask about {context}</span>
        </div>
        <p className="text-sm mt-0.5" style={{ color: "#9CA3AF" }}>Contextual AI assistant</p>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {messages.length === 0 && !typing ? (
          <div className="flex flex-col gap-3 pt-4">
            <p className="text-sm text-center text-gray-400">Ask a question about the view on the left.</p>
            <div className="flex flex-col gap-1.5">
              {suggested.map((q) => (
                <button
                  key={q}
                  onClick={() => setInput(q)}
                  className="text-left text-sm px-3 py-2 rounded-lg border hover:bg-gray-50 text-gray-600 transition-colors"
                  style={{ borderColor: C.border }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div
              key={i}
              className={`max-w-[90%] text-sm rounded-lg px-3 py-2 leading-relaxed whitespace-pre-wrap ${
                m.role === "user" ? "ml-auto" : m.role === "error" ? "border border-red-300 bg-red-50 text-red-800" : "bg-gray-100 text-gray-800"
              }`}
              style={m.role === "user" ? { background: "#FFF3D0", color: C.ink } : {}}
            >
              {m.text}
              {m.sql ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium select-none" style={{ color: C.link }}>
                    Show sources ({m.rowCount ?? 0} row{m.rowCount === 1 ? "" : "s"})
                  </summary>
                  <pre className="mt-1 overflow-x-auto rounded p-2 text-xs text-gray-700 whitespace-pre-wrap" style={{ background: "rgba(0,0,0,0.04)" }}>
                    {m.sql}
                  </pre>
                </details>
              ) : null}
            </div>
          ))
        )}
        {typing && (
          <div className="max-w-[90%] bg-gray-100 rounded-lg px-3 py-2 flex gap-1 items-center">
            <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex-shrink-0 px-3 pb-3 pt-2 border-t flex items-end gap-2" style={{ borderColor: C.border }}>
        <textarea
          className="flex-1 resize-none text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-1"
          style={{ borderColor: C.border, minHeight: 36, maxHeight: 100 }}
          placeholder={`Ask about ${context}…`}
          value={input}
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); }
          }}
        />
        <button
          disabled={!input.trim() || typing}
          onClick={() => send(input)}
          className="flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center disabled:opacity-40 transition-colors"
          style={{ background: C.orange }}
        >
          <Send size={14} style={{ color: C.ink }} />
        </button>
      </div>
    </div>
  );
}

// ─── Category panels (rewritten against real Dashboard field shapes) ──────
function ExecutiveSummaryPanel({ d }: { d: Dashboard }) {
  const es = d.executive_summary;
  const bandTone: Tone = d.opportunity_score.band === "hot" ? "success" : d.opportunity_score.band === "warm" ? "warning" : "neutral";
  const riskTone: Tone = d.risk_assessment.overall_risk === "high" ? "danger" : d.risk_assessment.overall_risk === "medium" ? "warning" : "success";
  return (
    <div className="space-y-4">
      <div className="rounded-lg p-5 text-white" style={{ background: es.has_hard_blocker ? "#450a0a" : C.navy }}>
        {es.has_hard_blocker && (
          <div className="mb-4 border border-red-400 rounded bg-red-900/40 p-3">
            <p className="font-bold flex items-center gap-2">
              <AlertTriangle size={16} /> Hard blocker — Amazon cannot change this
            </p>
            <ul className="mt-1 list-disc pl-5 text-sm text-red-100">
              {(es.hard_blockers ?? []).map((r, i) => <li key={i}>{r.title}</li>)}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap gap-2 mb-3">
          <StatusBadge tone={bandTone}>{d.opportunity_score.band.toUpperCase()} OPPORTUNITY</StatusBadge>
          <StatusBadge tone={riskTone}>{d.risk_assessment.overall_risk.toUpperCase()} RISK</StatusBadge>
          <StatusBadge tone="info">{Math.round(d.win_probability.win_probability * 100)}% WIN PROBABILITY</StatusBadge>
        </div>
        <p className="font-bold text-xl">{es.decision_prompt}</p>
        <p className="text-white/70 text-base mt-1">{es.headline}</p>
      </div>
    </div>
  );
}

function OpportunityScorePanel({ data }: { data: OpportunityScore }) {
  const tone: Tone = data.band === "hot" ? "success" : data.band === "warm" ? "warning" : "neutral";
  return (
    <Card>
      <div className="flex items-baseline gap-3 mb-3">
        <span className="text-5xl font-bold" style={{ color: C.ink }}>{data.score}</span>
        <span className="text-lg text-gray-400">/100</span>
        <StatusBadge tone={tone}>{data.band.toUpperCase()}</StatusBadge>
      </div>
      <p className="text-base text-gray-600">{data.rationale}</p>
    </Card>
  );
}

function RiskAssessmentPanel({ data }: { data: RiskAssessment }) {
  const st = (s: string): Tone => s === "high" ? "danger" : s === "medium" ? "warning" : "neutral";
  return (
    <Card>
      {data.risks.length === 0 ? (
        <p className="text-gray-400 text-base">No operational, commercial, or financial risks identified from current data.</p>
      ) : (
        <div className="space-y-2">
          {data.risks.map((r, i) => (
            <div key={i} className={`flex items-center gap-3 p-3 rounded ${r.hard_blocker ? "border border-red-300 bg-red-50" : "bg-gray-50"}`}>
              {r.hard_blocker ? <StatusBadge tone="danger">HARD BLOCKER</StatusBadge> : null}
              <StatusBadge tone={st(r.severity)}>{r.category}</StatusBadge>
              <span className="text-base text-gray-800">{r.title}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// Collapsible "show the data behind this" — a step-by-step arithmetic
// trace (label, the exact numbers plugged in, the result), closed by
// default so it doesn't clutter the panel until someone wants to verify
// a number rather than just read the prose rationale.
function CalculationTrace({ steps }: { steps: CalculationStep[] }) {
  if (steps.length === 0) return null;
  return (
    <details className="mt-2 group">
      <summary
        className="cursor-pointer text-sm font-medium select-none"
        style={{ color: C.link }}
      >
        Show the math
      </summary>
      <ol className="mt-2 space-y-1.5 border-l-2 pl-3" style={{ borderColor: C.border }}>
        {steps.map((s, i) => (
          <li key={i} className="text-sm">
            <span className="text-gray-500">{s.label}:</span>{" "}
            <code className="text-xs text-gray-700">{s.expression}</code>
            {s.unit ? <span className="text-gray-400"> {s.unit}</span> : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

function PricingPanel({ data }: { data: PricingRecommendations }) {
  return (
    <div className="space-y-4">
      {data.error ? (
        // pricing_recommendations.py returns this on an early exit (no
        // volume captured, or — most commonly — the opportunity's stated
        // geography has no region_multipliers row, e.g. anything outside
        // Spanish Peninsula/Balearic Islands) and omits guardrails/
        // scenarios entirely in that case, so this has to render before
        // assuming either array is present.
        <Card className="border-red-200 bg-red-50">
          <p className="text-base text-danger">⚠ {data.error}</p>
        </Card>
      ) : null}
      {data.scenarios.length === 0 ? (
        data.error ? null : (
          <Card><p className="text-gray-400 text-base">Not enough data to price this opportunity yet.</p></Card>
        )
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {data.scenarios.map((s) => {
            const isRec = s.name === data.recommended_scenario;
            return (
              <Card key={s.name} className={isRec ? "ring-1" : ""} style={isRec ? { borderColor: C.orange, background: "#FFFBF0", boxShadow: `0 0 0 1px ${C.orange}` } : {}}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-bold tracking-wide uppercase text-gray-500">{s.name}</span>
                  {s.guardrail_result ? <StatusBadge tone={guardrailTone(s.guardrail_result)}>{s.guardrail_result.replace(/_/g, " ")}</StatusBadge> : null}
                </div>
                <div className="text-3xl font-bold mb-1" style={{ color: C.ink }}>€{s.price_per_package_eur.toLocaleString()}</div>
                <div className="text-base text-gray-500 mb-3">per package · {s.target_margin_pct}% margin</div>
                {s.contract_value_eur != null ? (
                  <p className="text-sm text-gray-500 mb-2">Contract value: €{s.contract_value_eur.toLocaleString()}</p>
                ) : null}
                <p className="text-sm text-gray-700 mb-1"><strong>Rationale:</strong> {s.rationale}</p>
                <p className="text-sm text-gray-600 mb-1"><strong>Tradeoffs:</strong> {s.tradeoffs}</p>
                <p className="text-sm text-gray-600"><strong>Strategy:</strong> {s.negotiation_strategy}</p>
                <CalculationTrace steps={s.calculation ?? []} />
              </Card>
            );
          })}
        </div>
      )}
      {(data.guardrails ?? []).map((note, i) => (
        <p key={i} className="text-sm" style={{ color: C.warning }}>⚠ {note}</p>
      ))}
      {data.cost_calculation || data.evidence ? (
        <Card>
          <details className="group">
            <summary className="cursor-pointer text-sm font-bold select-none" style={{ color: C.ink }}>
              Show the data behind the cost calculation
            </summary>
            <div className="mt-3 space-y-4">
              {data.cost_calculation ? <CalculationTrace steps={data.cost_calculation} /> : null}

              {data.evidence?.cost_matrix_rows.length ? (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1.5">
                    cost_matrix rows used
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-gray-400">
                          <th className="pr-4 font-medium">Mile type</th>
                          <th className="pr-4 font-medium">Volume band</th>
                          <th className="pr-4 font-medium">Avg cost (EUR)</th>
                          <th className="font-medium">Weight bands averaged</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.evidence.cost_matrix_rows.map((r, i) => (
                          <tr key={i} className="border-t" style={{ borderColor: C.border }}>
                            <td className="pr-4 py-1 text-gray-700">{r.mile_type}</td>
                            <td className="pr-4 py-1 text-gray-600">{r.daily_volume_band}</td>
                            <td className="pr-4 py-1 text-gray-600">{r.avg_cost_eur}</td>
                            <td className="py-1 text-gray-600">{r.weight_band_samples}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {data.evidence?.region_multiplier_rows_matched.length ? (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1.5">
                    region_multipliers rows matched
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {data.evidence.region_multiplier_rows_matched.map((r, i) => (
                      <span key={i} className="text-sm px-2 py-0.5 rounded border text-gray-600" style={{ borderColor: C.border, background: C.canvas }}>
                        {r.region_name} — {r.cost_multiplier}x
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {data.evidence?.guardrails_row ? (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1.5">
                    pricing_guardrails row used
                    {data.evidence.guardrails_row.effective_date ? ` (effective ${data.evidence.guardrails_row.effective_date})` : ""}
                  </p>
                  <p className="text-sm text-gray-600">
                    min {data.evidence.guardrails_row.min_contribution_margin_pct}% · target {data.evidence.guardrails_row.target_contribution_margin_pct}% ·
                    {" "}VP approval below {data.evidence.guardrails_row.vp_approval_required_below_pct}% · auto no-go below {data.evidence.guardrails_row.auto_no_go_below_pct}%
                  </p>
                </div>
              ) : null}
            </div>
          </details>
        </Card>
      ) : null}
    </div>
  );
}

function CommercialStrategyPanel({ data }: { data: CommercialStrategy }) {
  if (!data.positioning_statement) {
    return <Card><p className="text-gray-400 text-base">Not enough client/competitive data yet to recommend a strategy.</p></Card>;
  }
  return (
    <Card>
      <p className="text-base font-semibold text-gray-800 mb-4 italic">&ldquo;{data.positioning_statement}&rdquo;</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <div>
            <p className="text-sm font-bold uppercase tracking-wide text-gray-500 mb-2">Lead with</p>
            <ul className="space-y-1.5">{data.lead_with_strengths.map((s, i) => <li key={i} className="text-base flex gap-2"><CheckCircle size={16} className="mt-0.5 flex-shrink-0" style={{ color: C.success }} />{s}</li>)}</ul>
          </div>
          <div>
            <p className="text-sm font-bold uppercase tracking-wide text-gray-500 mb-2">Objections to pre-empt</p>
            <ul className="space-y-1.5">{data.objections_to_preempt.map((o, i) => <li key={i} className="text-base flex gap-2"><AlertCircle size={16} className="mt-0.5 flex-shrink-0 text-amber-500" />{o}</li>)}</ul>
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <p className="text-sm font-bold uppercase tracking-wide text-gray-500 mb-2">Align to client priorities</p>
            <ul className="space-y-1.5">{data.align_to_priorities.map((p, i) => <li key={i} className="text-base flex gap-2"><Target size={16} className="mt-0.5 flex-shrink-0" style={{ color: C.link }} />{p}</li>)}</ul>
          </div>
          {data.capability_gaps_to_flag.length > 0 ? (
            <div>
              <p className="text-sm font-bold uppercase tracking-wide text-danger mb-2">Capability gaps to flag</p>
              <ul className="space-y-1.5">
                {data.capability_gaps_to_flag.map((g, i) => (
                  <li key={i} className={`text-sm flex gap-2 ${g.is_hard_blocker ? "font-semibold" : ""}`} style={{ color: g.is_hard_blocker ? C.danger : "#374151" }}>
                    {g.is_hard_blocker ? <StatusBadge tone="danger">HARD BLOCKER</StatusBadge> : null}
                    {g.constraint_name}: {g.gap_description}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="pt-3 border-t" style={{ borderColor: C.border }}>
            <p className="text-sm font-bold uppercase tracking-wide text-gray-500 mb-2">Negotiation</p>
            <p className="text-base text-gray-700">{data.negotiation_approach}</p>
          </div>
        </div>
      </div>
    </Card>
  );
}

// Polls draft_send_log (via follow_up_actions.py's draft_status action)
// after a send. "sent_to_zapier" just means our own POST succeeded; it
// only flips to "completed"/"failed" once the Zap's final step calls
// /api/zapier-draft-callback after Gmail's "Create Draft" actually runs.
async function pollDraftStatus(opportunityId: string, draftId: string, label: string, setMessage: (s: string) => void) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    const status = await callSkill<{ ok: boolean; status?: string }>("follow_up_actions", opportunityId, ["draft_status", draftId]);
    if (status?.status === "completed") { setMessage(`${label} — confirmed created in Gmail drafts.`); return; }
    if (status?.status === "failed") { setMessage(`${label} — Zapier reported a failure creating the Gmail draft.`); return; }
  }
  setMessage(`${label} — no completion confirmation received after 1 minute. Check Gmail directly.`);
}

function FollowUpActionsPanel({ data, opportunityId }: { data: FollowUpActions; opportunityId: string }) {
  const pt = (p: string): Tone => p === "high" ? "danger" : p === "medium" ? "warning" : "neutral";
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function sendClientReplyDraft() {
    setPending(true);
    setMessage("");
    const result = await callSkill<{ ok: boolean; to?: string; subject?: string; error?: string; draft_id?: string }>(
      "follow_up_actions", opportunityId, ["send_client_reply"],
    );
    setPending(false);
    if (!result || !result.ok) { setMessage(`Failed to send client reply: ${result?.error ?? "unknown error"}`); return; }
    const label = `Client reply draft ("${result.subject}") sent to Zapier for ${result.to}`;
    setMessage(`${label} — waiting for confirmation…`);
    if (result.draft_id) pollDraftStatus(opportunityId, result.draft_id, label, setMessage);
  }

  async function sendFollowUpDraft() {
    setPending(true);
    setMessage("");
    const result = await callSkill<{ ok: boolean; to?: string; open_action_count?: number; error?: string; draft_id?: string }>(
      "follow_up_actions", opportunityId, ["send_draft"],
    );
    setPending(false);
    if (!result || !result.ok) { setMessage(`Failed to send internal summary: ${result?.error ?? "unknown error"}`); return; }
    const label = `Internal summary sent to Zapier for ${result.to} (${result.open_action_count} open action(s))`;
    setMessage(`${label} — waiting for confirmation…`);
    if (result.draft_id) pollDraftStatus(opportunityId, result.draft_id, label, setMessage);
  }

  return (
    <Card>
      {data.actions.length === 0 ? (
        <p className="text-gray-400 text-base">No open questions, meetings, or validations required — clear to proceed.</p>
      ) : (
        <div className="space-y-2">
          {data.actions.map((a, i) => {
            const isHardBlocker = a.type === "hard_blocker_escalation";
            return (
              <div key={i} className={`flex items-center gap-3 p-3 rounded ${isHardBlocker ? "border border-red-300 bg-red-50" : "bg-gray-50"}`}>
                {isHardBlocker ? <StatusBadge tone="danger">HARD BLOCKER</StatusBadge> : null}
                <StatusBadge tone={pt(a.priority)}>{a.priority.toUpperCase()}</StatusBadge>
                <span className="text-base text-gray-800">{a.action}</span>
              </div>
            );
          })}
        </div>
      )}
      {data.actions.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-4" style={{ borderColor: C.border }}>
          <button
            onClick={sendClientReplyDraft}
            disabled={pending}
            title="Client-facing reply — only uses vetted, hard-blocker-safe content. Never includes internal escalation text."
            className="h-9 rounded px-3 text-sm font-semibold disabled:opacity-60"
            style={{ background: C.orange, color: C.ink }}
          >
            {pending ? "Sending…" : "Send Client Reply Draft (via Zapier)"}
          </button>
          <button
            onClick={sendFollowUpDraft}
            disabled={pending}
            title="Internal-only summary, includes hard-blocker escalations verbatim. Not for the client."
            className="h-9 rounded border px-3 text-sm font-medium disabled:opacity-60"
            style={{ borderColor: C.border, color: C.link }}
          >
            Send Internal Summary (via Zapier)
          </button>
        </div>
      ) : null}
      {message ? <p className="mt-2 text-sm text-gray-600">{message}</p> : null}
    </Card>
  );
}

function WinProbabilityPanel({ data }: { data: WinProbability }) {
  return (
    <Card>
      <div className="flex items-baseline gap-4 mb-3">
        <span className="text-5xl font-bold" style={{ color: C.ink }}>{Math.round(data.win_probability * 100)}%</span>
        <span className="text-base text-gray-500">vs. {Math.round(data.base_rate * 100)}% base rate</span>
      </div>
      <p className="text-base text-gray-600 mb-4">{data.rationale}</p>
      {data.top_drivers.length > 0 ? (
        <>
          <p className="text-sm font-bold uppercase tracking-wide text-gray-500 mb-2">Top drivers</p>
          <div className="space-y-2">
            {data.top_drivers.map((dr, i) => (
              <div key={i} className="flex items-center gap-2">
                <StatusBadge tone={dr.effect >= 0 ? "success" : "danger"}>{dr.effect >= 0 ? "WIN" : "LOSS"}</StatusBadge>
                <span className="text-base text-gray-700">{dr.factor}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="text-gray-400 text-base">No win/loss signals checked yet — probability is the historical base rate.</p>
      )}
    </Card>
  );
}

function SourcesFooter({ data }: { data: SourcesUsed }) {
  return (
    <div className="mt-6 pt-4 border-t" style={{ borderColor: C.border }}>
      <div className="flex items-center gap-2 mb-3">
        <BookOpen size={14} style={{ color: C.muted }} />
        <span className="text-sm font-semibold text-gray-500">Sources used</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Challenge documents</p>
          <div className="flex flex-wrap gap-2">
            {data.challenge_documents.map((d, i) => (
              <span key={i} className="text-sm px-2 py-0.5 rounded border text-gray-600" style={{ borderColor: C.border, background: C.canvas }}>
                {d.filename}
              </span>
            ))}
            <span className="text-sm px-2 py-0.5 rounded border text-gray-500" style={{ borderColor: C.border, background: C.canvas }}>
              {data.email_correspondence.messages} emails
            </span>
            <span className="text-sm px-2 py-0.5 rounded border text-gray-500" style={{ borderColor: C.border, background: C.canvas }}>
              {data.extracted_evidence.tender_constraints_extracted} constraints
            </span>
          </div>
        </div>
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Internal references</p>
          <div className="flex flex-col gap-1">
            {Object.entries(data.internal_reference_data).map(([key, val]) => {
              if (!val || typeof val === "string") return null;
              return (
                <div key={key} className="flex items-center gap-2 text-sm text-gray-600">
                  <span className="font-medium text-gray-700">{key.replace(/_/g, " ")}</span>
                  <span className="text-gray-400">·</span>
                  <span>{val.total.toLocaleString()} rows</span>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-400">{val.used_by.join(", ")}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Nav config (Sources Used stays a footer under every panel, not its own item — matches the prototype) ──
type NavItem = { id: string; label: string; icon: React.ReactNode };
const NAV_ITEMS: NavItem[] = [
  { id: "executive_summary", label: "Executive Summary", icon: <FileText size={15} /> },
  { id: "opportunity_score", label: "Opportunity Score", icon: <Target size={15} /> },
  { id: "risk_assessment", label: "Risk Assessment", icon: <AlertTriangle size={15} /> },
  { id: "pricing_recommendations", label: "Pricing Recommendation", icon: <DollarSign size={15} /> },
  { id: "commercial_strategy", label: "Commercial Strategy", icon: <Briefcase size={15} /> },
  { id: "follow_up_actions", label: "Required Follow-Up Actions", icon: <CheckSquare size={15} /> },
  { id: "client_proposal", label: "Client Proposal / Pitch Deck", icon: <Presentation size={15} /> },
  { id: "win_probability", label: "Win Probability Score", icon: <BarChart2 size={15} /> },
];

// ─── Executive mode ─────────────────────────────────────────────────────────
function ExecutiveMode() {
  const [opps, setOpps] = useState<OpportunityOption[]>([]);
  const [oppsError, setOppsError] = useState<string | null>(null);
  const [selectedOpp, setSelectedOpp] = useState("");
  const [activeId, setActiveId] = useState("executive_summary");
  const [skillError, setSkillError] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingSkill, setLoadingSkill] = useState("");
  const [pitchAcknowledged, setPitchAcknowledged] = useState(false);

  useEffect(() => {
    listOpportunitiesForIngestion().then((res) => {
      if (res.ok && res.data && res.data.length > 0) {
        setOpps(res.data);
        setSelectedOpp(res.data[0].opportunity_id);
        return;
      }
      setOppsError(!res.ok ? (res.error ?? "unknown error") : "No opportunities found in the database.");
    });
  }, []);

  function handleLoad() {
    if (!selectedOpp) return;
    setDashboard(null);
    setSkillError("");
    setLoading(true);
    (async () => {
      const results: Record<string, unknown> = {};
      const errors: string[] = [];
      for (const skill of SKILL_LOAD_ORDER) {
        setLoadingSkill(NAV_ITEMS.find((n) => n.id === skill)?.label ?? skill.replace(/_/g, " "));
        results[skill] = await callSkill(skill, selectedOpp, undefined, (s, m) => {
          if (errors.length === 0) errors.push(s + ": " + m);
          else if (!errors[0].includes(m)) errors.push(s);
        });
      }
      setSkillError(
        errors.length > 0
          ? errors[0] + (errors.length > 1 ? " (+" + (errors.length - 1) + " more skills failed the same way)" : "")
          : "",
      );
      setDashboard({
        executive_summary: (results.executive_summary as ExecutiveSummary) ?? { headline: "", decision_prompt: "" },
        opportunity_score: (results.opportunity_score as OpportunityScore) ?? { score: 0, band: "cold", rationale: "" },
        win_probability: (results.win_probability as WinProbability) ?? { win_probability: 0, base_rate: 0, top_drivers: [], rationale: "" },
        risk_assessment: (results.risk_assessment as RiskAssessment) ?? { overall_risk: "none", risk_count: 0, risks: [], has_hard_blocker: false, hard_blockers: [] },
        commercial_strategy: (results.commercial_strategy as CommercialStrategy) ?? {
          positioning_statement: "", lead_with_strengths: [], address_client_pains: [], align_to_priorities: [],
          objections_to_preempt: [], negotiation_approach: "", capability_gaps_to_flag: [], has_hard_blocker: false,
        },
        pricing_recommendations: (results.pricing_recommendations as PricingRecommendations) ?? {
          recommended_scenario: "", scenarios: [], guardrails: [], financial_guardrails: null,
        },
        follow_up_actions: (results.follow_up_actions as FollowUpActions) ?? { open_action_count: 0, actions: [] },
        client_proposal: (results.client_proposal as ClientProposal) ?? {
          sections: {
            cover: { title: "", subtitle: "" },
            understanding_your_needs: { points: [] },
            why_amazon_shipping: { positioning: "", differentiators: [], proof_points: [] },
            commercial_proposal: { selected_scenario: "", scenario: null },
            next_steps: { points: [] },
          },
          internal_flags: { has_hard_blocker: false, hard_blockers: [] },
        },
        sources_used: (results.sources_used as SourcesUsed) ?? {
          challenge_documents: [], email_correspondence: { threads: 0, messages: 0 },
          extracted_evidence: { tender_constraints_extracted: 0, client_highlights_by_source: {} },
          internal_reference_data: {},
        },
      });
      setLoading(false);
      setLoadingSkill("");
    })();
  }

  const activeNav = NAV_ITEMS.find((n) => n.id === activeId)!;
  const activeOpp = opps.find((o) => o.opportunity_id === selectedOpp);

  const getBadge = (id: string) => {
    if (!dashboard) return null;
    if (id === "executive_summary" && dashboard.executive_summary.has_hard_blocker) return <StatusBadge tone="danger">⚠</StatusBadge>;
    if (id === "risk_assessment" && dashboard.risk_assessment.overall_risk !== "none") return <StatusBadge tone="warning">{dashboard.risk_assessment.risk_count}</StatusBadge>;
    if (id === "follow_up_actions" && dashboard.follow_up_actions.open_action_count > 0) return (
      <span className="text-xs font-bold rounded-full px-1.5 py-0.5" style={{ background: C.orange, color: C.ink, fontSize: 10 }}>{dashboard.follow_up_actions.open_action_count}</span>
    );
    if (id === "opportunity_score") {
      const color = dashboard.opportunity_score.band === "hot" ? C.success : dashboard.opportunity_score.band === "warm" ? C.warning : C.muted;
      return <span className="w-2 h-2 rounded-full inline-block flex-shrink-0" style={{ background: color }} />;
    }
    if (id === "client_proposal" && dashboard.client_proposal.internal_flags.has_hard_blocker) return <StatusBadge tone="danger">⚠</StatusBadge>;
    if (id === "commercial_strategy" && dashboard.commercial_strategy.has_hard_blocker) return <span className="w-2 h-2 rounded-full inline-block flex-shrink-0" style={{ background: C.danger }} />;
    return null;
  };

  const renderPanel = () => {
    if (!dashboard) {
      return (
        <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-400">
          {loading ? (
            <><Loader2 size={36} className="animate-spin" style={{ color: C.orange }} /><p className="text-base">Loading {loadingSkill}…</p></>
          ) : (
            <><BarChart2 size={56} className="opacity-20" /><p className="text-base">Select an opportunity and click Load Dashboard.</p></>
          )}
        </div>
      );
    }
    const sources = <SourcesFooter data={dashboard.sources_used} />;
    const panel = (() => {
      switch (activeId) {
        case "executive_summary": return <ExecutiveSummaryPanel d={dashboard} />;
        case "opportunity_score": return <OpportunityScorePanel data={dashboard.opportunity_score} />;
        case "risk_assessment": return <RiskAssessmentPanel data={dashboard.risk_assessment} />;
        case "pricing_recommendations": return <PricingPanel data={dashboard.pricing_recommendations} />;
        case "commercial_strategy": return <CommercialStrategyPanel data={dashboard.commercial_strategy} />;
        case "follow_up_actions": return <FollowUpActionsPanel data={dashboard.follow_up_actions} opportunityId={selectedOpp} />;
        case "client_proposal":
          return (
            <RealPitchDeckPanel
              dashboard={dashboard}
              customerName={activeOpp?.customer_name ?? "Client"}
              opportunityTitle={activeOpp?.title ?? dashboard.client_proposal.sections.cover.subtitle}
            />
          );
        case "win_probability": return <WinProbabilityPanel data={dashboard.win_probability} />;
        default: return null;
      }
    })();
    return <>{panel}{sources}</>;
  };

  return (
    <div className="flex min-h-[calc(100vh-56px)] mt-14">
      <aside className="w-56 flex-shrink-0 fixed top-14 left-0 bottom-0 overflow-y-auto flex flex-col border-r" style={{ background: C.surface, borderColor: C.border }}>
        <div className="p-3 border-b" style={{ borderColor: C.border }}>
          <label className="text-sm font-semibold text-gray-500 block mb-1">Opportunity</label>
          {dashboard ? (
            // Once a dashboard has been run for a document, the picker/button
            // disappear rather than staying clickable — re-running requires
            // reloading the page, not a second click here.
            <p className="text-sm" style={{ color: C.ink }}>
              {activeOpp ? `${activeOpp.customer_name} — ${activeOpp.title}` : "Loaded"}
            </p>
          ) : oppsError ? (
            <p className="text-xs text-danger">{oppsError}</p>
          ) : (
            <>
              <div className="relative">
                <select className="w-full text-sm border rounded px-2 py-1.5 pr-6 appearance-none focus:outline-none" style={{ borderColor: C.border, color: C.ink }} value={selectedOpp} onChange={(e) => setSelectedOpp(e.target.value)} disabled={loading}>
                  {opps.map((o) => <option key={o.opportunity_id} value={o.opportunity_id}>{o.customer_name} — {o.title}</option>)}
                </select>
                <ChevronDown size={12} className="absolute right-2 top-2.5 text-gray-400 pointer-events-none" />
              </div>
              <button onClick={handleLoad} disabled={loading || !selectedOpp} className="mt-2 w-full h-10 rounded text-sm font-semibold transition-colors disabled:opacity-60" style={{ background: C.orange, color: C.ink }}>
                {loading ? `Loading…` : "Load Dashboard"}
              </button>
            </>
          )}
        </div>
        <nav className="flex-1 py-2">
          {NAV_ITEMS.map((item) => {
            const isActive = activeId === item.id;
            const isDisabled = !dashboard;
            return (
              <button key={item.id} disabled={isDisabled} onClick={() => setActiveId(item.id)}
                className="w-full flex items-center gap-2 px-3 h-10 text-left text-sm transition-colors"
                style={{ color: isDisabled ? "#9CA3AF" : isActive ? "white" : C.ink, background: isActive ? C.navy : "transparent", borderLeft: isActive ? `3px solid ${C.orange}` : "3px solid transparent", cursor: isDisabled ? "not-allowed" : "pointer" }}>
                <span className="flex-shrink-0">{item.icon}</span>
                <span className="flex-1 leading-tight">{item.label}</span>
                {getBadge(item.id)}
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="flex-1 ml-56 mr-72 p-5 min-h-full" style={{ background: C.canvas }}>
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold" style={{ color: C.ink }}>{activeNav.label}</h1>
        </div>
        {skillError ? (
          <div className="mb-4 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
            <span className="font-bold">AI skills unavailable — panels below show empty defaults, not real analysis.</span>{" "}
            {skillError}
          </div>
        ) : null}
        {renderPanel()}
      </main>

      <aside className="w-72 flex-shrink-0 fixed top-14 right-0 bottom-0 border-l flex flex-col" style={{ borderColor: C.border }}>
        <ChatPanel context={activeNav.label} />
      </aside>
    </div>
  );
}

// ─── Employee mode — visual flow diagram (status values are illustrative;
// not yet polled from real retrieval/ingestion state, see file header) ────
type StepStatus = "complete" | "active" | "idle";
type DetailStatus = "indexed" | "indexing" | "queued";

const statusDetailTone = (s: DetailStatus): Tone =>
  s === "indexed" ? "success" : s === "indexing" ? "warning" : "neutral";

const statusIcon = (s: StepStatus) => {
  if (s === "complete") return <CircleCheck size={16} style={{ color: C.success }} />;
  if (s === "active") return <CircleDot size={16} style={{ color: C.orange }} className="animate-pulse" />;
  return <Circle size={16} style={{ color: C.border }} />;
};

type PipelineStepData = {
  id: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  status: StepStatus;
  detail: { label: string; status: DetailStatus }[];
  action?: string;
};

function FlowCard({ step }: { step: PipelineStepData }) {
  const borderColor = step.status === "complete" ? C.success : step.status === "active" ? C.orange : C.border;
  const bgColor = step.status === "complete" ? "#F0FDF4" : step.status === "active" ? "#FFFBF0" : C.surface;
  const iconBg = step.status === "complete" ? "#DCFCE7" : step.status === "active" ? "#FFF3D0" : "#F3F4F6";
  const iconColor = step.status === "complete" ? C.success : step.status === "active" ? C.orangeDark : C.muted;

  return (
    <div className="rounded-xl border-2 p-4 h-full" style={{ borderColor, background: bgColor }}>
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: iconBg }}>
          <span style={{ color: iconColor }}>{step.icon}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="font-semibold text-base" style={{ color: C.ink }}>{step.title}</span>
            {statusIcon(step.status)}
          </div>
          <p className="text-sm text-gray-500 mb-2">{step.subtitle}</p>
          {step.detail.length > 0 && (
            <div className="space-y-1.5 mb-2">
              {step.detail.map((d, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <StatusBadge tone={statusDetailTone(d.status)}>{d.status}</StatusBadge>
                  <span className="text-sm text-gray-600 truncate">{d.label}</span>
                </div>
              ))}
            </div>
          )}
          {step.action && (
            <button className="mt-1 text-sm font-semibold px-3 h-8 rounded-md" style={{ background: C.orange, color: C.ink }}>
              {step.action}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Real upload card — same visual language as FlowCard, but backed by
// an actual file input wired to the live /api/tender-upload or
// /api/email-import routes (both already work against the real schema;
// only the UI to reach them was missing). ─────────────────────────────
type UploadCardProps = {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  accept: string;
  actionLabel: string;
  uploading: boolean;
  message: string | null;
  messageIsError: boolean;
  items: { label: string; status: DetailStatus }[];
  disabled: boolean;
  disabledReason?: string;
  onFile: (file: File) => void;
};

function IngestionUploadCard({
  icon, title, subtitle, accept, actionLabel, uploading, message, messageIsError, items, disabled, disabledReason, onFile,
}: UploadCardProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const status: StepStatus = uploading ? "active" : items.length > 0 ? "complete" : "idle";
  const borderColor = status === "complete" ? C.success : status === "active" ? C.orange : C.border;
  const bgColor = status === "complete" ? "#F0FDF4" : status === "active" ? "#FFFBF0" : C.surface;
  const iconBg = status === "complete" ? "#DCFCE7" : status === "active" ? "#FFF3D0" : "#F3F4F6";
  const iconColor = status === "complete" ? C.success : status === "active" ? C.orangeDark : C.muted;

  return (
    <div className="rounded-xl border-2 p-4 h-full" style={{ borderColor, background: bgColor }}>
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: iconBg }}>
          <span style={{ color: iconColor }}>{icon}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="font-semibold text-base" style={{ color: C.ink }}>{title}</span>
            {statusIcon(status)}
          </div>
          <p className="text-sm text-gray-500 mb-2">{subtitle}</p>

          {items.length > 0 ? (
            <div className="space-y-1.5 mb-2">
              {items.map((d, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <StatusBadge tone={statusDetailTone(d.status)}>{d.status}</StatusBadge>
                  <span className="text-sm text-gray-600 truncate">{d.label}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400 mb-2">Nothing uploaded yet.</p>
          )}

          <input
            ref={inputRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onFile(file);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => inputRef.current?.click()}
            disabled={disabled || uploading}
            title={disabled ? disabledReason : undefined}
            className="mt-1 text-sm font-semibold px-3 h-8 rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: C.orange, color: C.ink }}
          >
            {uploading ? "Uploading…" : actionLabel}
          </button>
          {message ? (
            <p className="mt-2 text-sm" style={{ color: messageIsError ? C.danger : C.success }}>{message}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MergeConnector() {
  return (
    <div className="relative w-full" style={{ height: 56 }}>
      <svg width="100%" height="56" viewBox="0 0 400 56" preserveAspectRatio="none" className="absolute inset-0">
        <line x1="25%" y1="0" x2="50%" y2="44" stroke={C.border} strokeWidth="1.5" />
        <line x1="75%" y1="0" x2="50%" y2="44" stroke={C.border} strokeWidth="1.5" />
        <line x1="50%" y1="44" x2="50%" y2="52" stroke={C.border} strokeWidth="1.5" />
        <polygon points="50%,56 calc(50% - 5),48 calc(50% + 5),48" fill={C.border} />
      </svg>
      <div className="absolute inset-0 flex items-start justify-center pt-1">
        <span className="text-sm text-gray-400 bg-canvas px-1.5 rounded" style={{ background: C.canvas }}>run concurrently</span>
      </div>
    </div>
  );
}

function DownArrow() {
  return (
    <div className="flex flex-col items-center my-0.5" style={{ height: 32 }}>
      <div className="w-px flex-1" style={{ background: C.border }} />
      <ArrowDown size={13} style={{ color: C.border }} />
    </div>
  );
}

function EmployeeMode() {
  const [opps, setOpps] = useState<OpportunityOption[]>([]);
  const [selectedOpp, setSelectedOpp] = useState("");

  const [tenderDocs, setTenderDocs] = useState<CoreDocument[]>([]);
  const [tenderUploading, setTenderUploading] = useState(false);
  const [tenderMessage, setTenderMessage] = useState<string | null>(null);
  const [tenderMessageIsError, setTenderMessageIsError] = useState(false);

  const [emailThreads, setEmailThreads] = useState<CoreEmailThread[]>([]);
  const [crmUploading, setCrmUploading] = useState(false);
  const [crmMessage, setCrmMessage] = useState<string | null>(null);
  const [crmMessageIsError, setCrmMessageIsError] = useState(false);

  useEffect(() => {
    listOpportunitiesForIngestion().then((res) => {
      if (res.ok && res.data && res.data.length > 0) {
        setOpps(res.data);
        setSelectedOpp(res.data[0].opportunity_id);
      }
    });
  }, []);

  useEffect(() => {
    if (!selectedOpp) return;
    listTenderDocuments(selectedOpp).then((res) => { if (res.ok && res.data) setTenderDocs(res.data); });
    listEmailThreads(selectedOpp).then((res) => { if (res.ok && res.data) setEmailThreads(res.data); });
    setTenderMessage(null);
    setCrmMessage(null);
  }, [selectedOpp]);

  async function uploadTenderFile(file: File) {
    if (!selectedOpp) return;
    setTenderUploading(true);
    setTenderMessage(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("opportunity_id", selectedOpp);
      const res = await fetch("/api/tender-upload", { method: "POST", body: fd });
      const json = await res.json();
      if (json.ok) {
        setTenderMessageIsError(false);
        setTenderMessage(`"${file.name}" indexed — ${json.data.chunk_count} chunk(s).`);
        const docs = await listTenderDocuments(selectedOpp);
        if (docs.ok && docs.data) setTenderDocs(docs.data);
      } else {
        setTenderMessageIsError(true);
        setTenderMessage(json.error ?? "Upload failed.");
      }
    } catch {
      setTenderMessageIsError(true);
      setTenderMessage("Could not reach the server.");
    }
    setTenderUploading(false);
  }

  async function uploadCrmFile(file: File) {
    if (!selectedOpp) return;
    setCrmUploading(true);
    setCrmMessage(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("opportunity_id", selectedOpp);
      const res = await fetch("/api/email-import", { method: "POST", body: fd });
      const json = await res.json();
      if (json.ok) {
        setCrmMessageIsError(false);
        setCrmMessage(
          json.data.messages_imported > 0
            ? `"${file.name}" imported — ${json.data.messages_imported} message(s).`
            : `"${file.name}" imported as CRM notes (${json.data.crm_notes_chunk_count} chunk(s)).`,
        );
        const threads = await listEmailThreads(selectedOpp);
        if (threads.ok && threads.data) setEmailThreads(threads.data);
      } else {
        setCrmMessageIsError(true);
        setCrmMessage(json.error ?? "Import failed.");
      }
    } catch {
      setCrmMessageIsError(true);
      setCrmMessage("Could not reach the server.");
    }
    setCrmUploading(false);
  }

  const retrieval: PipelineStepData = {
    id: "retrieval", icon: <RefreshCw size={18} />, title: "Retrieval & Indexing", subtitle: "Embedding pipeline",
    status: "active",
    detail: [{ label: "Constraint extraction", status: "indexing" }],
  };
  const capability: PipelineStepData = {
    id: "capability", icon: <Database size={18} />, title: "Capability Ingestion", subtitle: "Internal solution registry",
    status: "idle",
    detail: [{ label: "Capability registry", status: "queued" }],
    action: "Sync Capabilities",
  };

  return (
    <div className="flex min-h-[calc(100vh-56px)] mt-14">
      <main className="flex-1 mr-72 p-6 overflow-y-auto" style={{ background: C.canvas }}>
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-lg font-bold" style={{ color: C.ink }}>Ingestion Pipeline</h1>
              <p className="text-xs text-gray-500 mt-0.5">Feed data sources before running analysis</p>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-gray-500">Opportunity</label>
              <div className="relative">
                <select className="text-xs border rounded px-2 py-1.5 pr-6 appearance-none focus:outline-none bg-white" style={{ borderColor: C.border, color: C.ink }} value={selectedOpp} onChange={(e) => setSelectedOpp(e.target.value)}>
                  {opps.map((o) => <option key={o.opportunity_id} value={o.opportunity_id}>{o.customer_name} — {o.title}</option>)}
                </select>
                <ChevronDown size={11} className="absolute right-2 top-2.5 text-gray-400 pointer-events-none" />
              </div>
            </div>
          </div>

          <div className="mb-6">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>Pipeline progress</span>
              <span>Retrieval in progress</span>
            </div>
            <div className="h-2 rounded-full overflow-hidden" style={{ background: C.border }}>
              <div className="h-full rounded-full transition-all" style={{ width: "66%", background: C.orange }} />
            </div>
          </div>

          <div className="flex flex-col items-stretch">
            <div className="flex gap-4">
              <div className="flex-1">
                <IngestionUploadCard
                  icon={<Upload size={18} />}
                  title="Tender Documents"
                  subtitle="RFP, appendices, bid docs"
                  accept=".txt,.csv,.md,.pdf,.docx"
                  actionLabel="Upload document"
                  uploading={tenderUploading}
                  message={tenderMessage}
                  messageIsError={tenderMessageIsError}
                  items={tenderDocs.map((d) => ({ label: d.filename, status: "indexed" as DetailStatus }))}
                  disabled={!selectedOpp}
                  disabledReason="Select an opportunity first."
                  onFile={uploadTenderFile}
                />
              </div>
              <div className="flex-1">
                <IngestionUploadCard
                  icon={<Mail size={18} />}
                  title="CRM / Email Import"
                  subtitle="Discovery emails & notes"
                  accept=".txt,.csv,.md,.pdf,.docx"
                  actionLabel="Import file"
                  uploading={crmUploading}
                  message={crmMessage}
                  messageIsError={crmMessageIsError}
                  items={emailThreads.map((t) => ({ label: t.subject ?? "General correspondence", status: "indexed" as DetailStatus }))}
                  disabled={!selectedOpp}
                  disabledReason="Select an opportunity first."
                  onFile={uploadCrmFile}
                />
              </div>
            </div>
            <MergeConnector />
            <FlowCard step={retrieval} />
            <DownArrow />
            <FlowCard step={capability} />
          </div>
        </div>
      </main>

      <aside className="w-72 flex-shrink-0 fixed top-14 right-0 bottom-0 border-l flex flex-col" style={{ borderColor: C.border }}>
        <ChatPanel context="Ingestion Pipeline" />
      </aside>
    </div>
  );
}

// ─── Top bar ────────────────────────────────────────────────────────────────
function DashboardTopBar({ mode, onModeChange }: { mode: "employee" | "executive"; onModeChange: (m: "employee" | "executive") => void }) {
  return (
    <header className="fixed top-0 left-0 right-0 h-14 flex items-center px-4 z-50" style={{ background: C.ink }}>
      <div className="flex items-center gap-3 max-w-full w-full">
        <span className="text-white font-bold text-sm tracking-tight whitespace-nowrap">Amazon Supply Chain Services</span>
        <span className="text-xs px-2 py-0.5 rounded border text-gray-300 whitespace-nowrap" style={{ borderColor: "#3d5166" }}>
          {mode === "executive" ? "Unified Intelligence" : "Update Progress"}
        </span>

        <div className="flex items-center rounded-md overflow-hidden ml-1" style={{ background: C.navy, border: `1px solid #3d5166` }}>
          <button onClick={() => onModeChange("employee")} className="flex items-center gap-1.5 px-3 h-8 text-xs font-medium transition-colors"
            style={mode === "employee" ? { background: C.orange, color: C.ink } : { color: "#9CA3AF" }}>
            <Inbox size={13} />Employee
          </button>
          <button onClick={() => onModeChange("executive")} className="flex items-center gap-1.5 px-3 h-8 text-xs font-medium transition-colors"
            style={mode === "executive" ? { background: C.orange, color: C.ink } : { color: "#9CA3AF" }}>
            <BarChart2 size={13} />Executive
          </button>
        </div>

        <div className="ml-auto flex items-center gap-4">
          <Link
            href="/employee/operations"
            className="flex items-center gap-1.5 text-xs font-medium text-gray-300 hover:text-white"
          >
            <Inbox size={13} />
            Operations
          </Link>
          <Link
            href="/architecture"
            className="flex items-center gap-1.5 text-xs font-medium text-gray-300 hover:text-white"
          >
            <Database size={13} />
            Solution Architecture
          </Link>
          <Link
            href="/analytics"
            className="flex items-center gap-1.5 text-xs font-medium text-gray-300 hover:text-white"
          >
            <BarChart2 size={13} />
            Software Analytics
          </Link>
          <Link
            href="/historical-insights"
            className="flex items-center gap-1.5 text-xs font-medium text-gray-300 hover:text-white"
          >
            <BarChart2 size={13} />
            Historical Insights
          </Link>
          <span className="text-xs text-gray-400">Internal preview — sample data</span>
        </div>
      </div>
    </header>
  );
}

// ─── Root ───────────────────────────────────────────────────────────────────
export default function FigmaDashboard() {
  const [mode, setMode] = useState<"employee" | "executive">("executive");
  return (
    <div className="min-h-screen" style={{ fontFamily: "Inter, Arial, Helvetica, sans-serif", background: C.canvas }}>
      <DashboardTopBar mode={mode} onModeChange={setMode} />
      {mode === "executive" ? <ExecutiveMode /> : <EmployeeMode />}
    </div>
  );
}
