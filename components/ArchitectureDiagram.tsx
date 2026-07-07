"use client";

// Interactive "how the solution actually works" diagram for decision-makers
// evaluating the system — not gated behind login (see app/architecture/page.tsx
// and middleware.ts's matcher, which only protects /client and /employee).
//
// Grounded in the real schema (tender-analysis-schema.sql) and the retrieval
// model documented in RETRIEVAL_REQUIREMENTS.md: two separate companies'
// systems (client tender docs vs. Amazon's own CRM/email) write into a
// shared schema, which a curated internal reference layer and a pure-SQL
// derived-computation layer sit between, before the 9 skills compose a
// decision-ready output. Every node's copy below is a real table/column
// name and a real description — nothing here is placeholder content.
//
// Node boxes are grouped into stages for reading order, but the actual
// data flow is drawn as real SVG connector lines computed from each box's
// live DOM position (not just revealed as text in the side panel) — see
// buildEdgeList()/recomputeEdges() below.

import { useLayoutEffect, useRef, useState } from "react";

type ArchNode = {
  id: string;
  label: string;
  subtitle?: string;
  columns?: string[];
  description: string;
  fedBy?: string[];
  feedsInto?: string[];
  // Only set on the 9 skill nodes — skills/<id>/SKILL.md is the real file
  // that defines each skill's behavior. Per-department configurability of
  // that file (workflow owners tuning their own skill's rules) is planned,
  // not implemented — surfaced here so reviewers see it's on the roadmap.
  skillMdPath?: string;
  // Which department (a stage-6 node id) owns this skill's SKILL.md.
  ownedByDept?: string;
  // Only set on department nodes — the schema/reference tables that
  // department's domain experts tell the retrieval engine to prioritize
  // for their skills. This is the "upward" loop: departments aren't just
  // fed skill output, they also configure what gets retrieved for them,
  // same idea as historical_archetypes.py writing into
  // RETRIEVAL_REQUIREMENTS.md, generalized to every department. Rendered
  // as a distinct dashed edge, not a fedBy/feedsInto data-flow edge.
  requests?: string[];
};

type Stage = {
  title: string;
  subtitle: string;
  color: "source" | "schema" | "reference" | "derived" | "skill" | "department";
  nodes: ArchNode[];
};

const STAGES: Stage[] = [
  {
    title: "1 · Two Separate Companies' Systems",
    subtitle: "The client's own documents vs. Amazon's own CRM/email — never conflated.",
    color: "source",
    nodes: [
      {
        id: "client_tender_docs",
        label: "Client Tender & Contract Documents",
        description:
          "The prospective client's own RFP, contract draft, and appendices — the only source for what they're actually asking for (volumes, lanes, SLAs, constraints).",
        feedsInto: ["opportunity_features", "tender_constraints", "client_highlights"],
      },
      {
        id: "amazon_crm_email",
        label: "Amazon CRM / Email Correspondence",
        description:
          "Discovery calls, emails, and CRM notes from the Amazon sales team's own systems — a separate source from the tender documents, imported independently.",
        feedsInto: ["email_messages", "client_highlights"],
      },
    ],
  },
  {
    title: "2 · Shared Schema — Extraction Targets",
    subtitle: "The only 4 tables the retrieval engine actually writes to.",
    color: "schema",
    nodes: [
      {
        id: "opportunity_features",
        label: "opportunity_features",
        subtitle: "structured deal facts",
        columns: ["volume", "lanes", "geography", "industry_vertical", "contract_length_months", "required_sla_hours", "incumbent_provider", "requested_discount_pct", "field_confidence"],
        description: "Structured deal facts extracted from the tender contract. Each field carries its own confidence score, since extraction is LLM-driven — risk_assessment reads that score as a data-quality risk trigger.",
        fedBy: ["client_tender_docs"],
        feedsInto: ["pricing_recommendations", "commercial_strategy", "risk_assessment", "signal_check_results"],
      },
      {
        id: "tender_constraints",
        label: "tender_constraints",
        subtitle: "stated constraint text",
        columns: ["stated_text", "stated_value", "constraint_type_id", "confidence_score", "source_document_id"],
        description: "Every constraint statement in the tender (\"must deliver to mainland Spain within 48h\"), matched via embedding similarity to a constraint_catalog entry. Raw wording is always kept as audit evidence, even once matched.",
        fedBy: ["client_tender_docs"],
        feedsInto: ["constraint_compliance_results"],
      },
      {
        id: "client_highlights",
        label: "client_highlights",
        subtitle: "pains, priorities, objections",
        columns: ["highlight_type", "text", "source_type", "source_id"],
        description: "Growth objectives, pain points, stated priorities, and past complaints — tagged by whether they came from a document or an email, since the same field is sourced from two different companies' systems.",
        fedBy: ["client_tender_docs", "amazon_crm_email"],
        feedsInto: ["commercial_strategy", "client_proposal"],
      },
      {
        id: "email_messages",
        label: "email_messages / email_threads",
        subtitle: "correspondence state",
        columns: ["resolved"],
        description: "Imported CRM/email threads. The 'resolved' flag tracks whether a later message answered an earlier open question — a semantic-matching problem, not a simple keyword check.",
        fedBy: ["amazon_crm_email"],
        feedsInto: ["follow_up_actions"],
      },
    ],
  },
  {
    title: "3 · Internal Reference Data",
    subtitle: "Curated Amazon-side ground truth — never extracted from a client document.",
    color: "reference",
    nodes: [
      {
        id: "constraint_catalog",
        label: "constraint_catalog",
        columns: ["category_id", "name", "data_type", "unit"],
        description: "Amazon's fixed list of constraint types (Geography, SLA, Legal, Financial, Insurance, Customs, Data/Security, Packaging) that every tender constraint gets classified against.",
        feedsInto: ["constraint_compliance_results"],
      },
      {
        id: "amazon_capability_profile",
        label: "amazon_capability_profile",
        columns: ["capability_status", "structured_value", "owner_team"],
        description: "What Amazon Shipping can and can't actually do, per constraint type (can_do / cannot_do / can_do_with_conditions) — the ground truth that determines a hard blocker vs. a soft gap.",
        feedsInto: ["constraint_compliance_results"],
      },
      {
        id: "historical_tenders",
        label: "historical_tenders",
        description: "Past won/lost deals with real margins — anchors the pricing scenarios' aggressive / balanced / premium percentile bands.",
        feedsInto: ["pricing_recommendations"],
      },
      {
        id: "cost_matrix",
        label: "cost_matrix",
        description: "Rate lookup by mile type × daily volume band × weight band — the cost floor pricing_recommendations checks margin against.",
        feedsInto: ["pricing_recommendations"],
      },
      {
        id: "win_loss_signal_catalog",
        label: "win_loss_signal_catalog",
        columns: ["factor_name", "direction", "strength", "maps_to_feature"],
        description: "Factors correlated with winning or losing, derived from a model's SHAP values on historical outcomes.",
        feedsInto: ["signal_check_results"],
      },
    ],
  },
  {
    title: "4 · Derived Computation",
    subtitle: "Pure SQL joins — zero NLP, zero model calls.",
    color: "derived",
    nodes: [
      {
        id: "constraint_compliance_results",
        label: "constraint_compliance_results",
        description: "tender_constraints checked against amazon_capability_profile — a deterministic SQL join, not a model call. Produces satisfied / unsatisfied / unclear_needs_verification per constraint.",
        fedBy: ["tender_constraints", "constraint_catalog", "amazon_capability_profile"],
        feedsInto: ["risk_assessment", "commercial_strategy", "follow_up_actions"],
      },
      {
        id: "signal_check_results",
        label: "signal_check_results",
        description: "opportunity_features checked against win_loss_signal_catalog to see which win/loss factors are actually present for this specific deal.",
        fedBy: ["opportunity_features", "win_loss_signal_catalog"],
        feedsInto: ["win_probability"],
      },
    ],
  },
  {
    title: "5 · The 9 Skills",
    subtitle: "What the executive dashboard actually shows — each one owned by a department's domain expertise (stage 6) and composed from the layers above. ⚙ = behavior defined by a skills/<name>/SKILL.md file (planned: per-department configurable, not yet implemented).",
    color: "skill",
    nodes: [
      { id: "opportunity_score", label: "Opportunity Score", description: "Numerical attractiveness score, primarily from estimated deal value.", fedBy: ["opportunities"], skillMdPath: "skills/opportunity_score/SKILL.md", ownedByDept: "dept_finance" },
      { id: "win_probability", label: "Win Probability Score", description: "Historical base rate adjusted by which win/loss signals are present for this deal.", fedBy: ["signal_check_results"], skillMdPath: "skills/win_probability/SKILL.md", ownedByDept: "dept_finance" },
      { id: "risk_assessment", label: "Risk Assessment", description: "Operational, commercial, and financial risks from low-confidence fields and unsatisfied constraints.", fedBy: ["opportunity_features", "constraint_compliance_results"], skillMdPath: "skills/risk_assessment/SKILL.md", ownedByDept: "dept_tech" },
      { id: "pricing_recommendations", label: "Pricing Recommendation", description: "Three pricing scenarios anchored on historical won-deal margins, floored at the financial guardrails.", fedBy: ["historical_tenders", "cost_matrix", "opportunity_features"], skillMdPath: "skills/pricing_recommendations/SKILL.md", ownedByDept: "dept_finance" },
      { id: "commercial_strategy", label: "Commercial Strategy", description: "Positioning and negotiation approach from client pains/priorities, proof points, and flagged capability gaps.", fedBy: ["client_highlights", "constraint_compliance_results"], skillMdPath: "skills/commercial_strategy/SKILL.md", ownedByDept: "dept_sales_ops" },
      { id: "follow_up_actions", label: "Required Follow-Up Actions", description: "Open questions and validations still needed, including unresolved email threads.", fedBy: ["email_messages", "constraint_compliance_results"], skillMdPath: "skills/follow_up_actions/SKILL.md", ownedByDept: "dept_sales_ops" },
      { id: "client_proposal", label: "Client Proposal / Pitch Deck", description: "Composes commercial strategy + pricing + client highlights into the client-facing deck sections.", fedBy: ["commercial_strategy", "pricing_recommendations", "client_highlights"], skillMdPath: "skills/client_proposal/SKILL.md", ownedByDept: "dept_sales_ops" },
      { id: "executive_summary", label: "Executive Summary", description: "The convergence point — composes every skill above into one decision-ready summary and recommendation.", fedBy: ["opportunity_score", "win_probability", "risk_assessment", "commercial_strategy", "pricing_recommendations", "follow_up_actions"], skillMdPath: "skills/executive_summary/SKILL.md", ownedByDept: "dept_tech" },
      { id: "sources_used", label: "Sources Used", description: "Full audit trail of every document, email, and internal reference table actually used for this opportunity.", fedBy: ["documents", "email_messages", "tender_constraints"], skillMdPath: "skills/sources_used/SKILL.md", ownedByDept: "dept_sales_ops" },
    ],
  },
  {
    title: "6 · Departments — Domain Ownership",
    subtitle: "The people behind the skills above. Each department owns its skills' SKILL.md AND tells the retrieval engine what to prioritize for its domain — the upward loop that makes this a copilot, not a one-way report.",
    color: "department",
    nodes: [
      {
        id: "dept_sales_ops",
        label: "Sales Operations",
        description: "Owns the client-facing skills — commercial positioning, the proposal deck, follow-up tracking, and the audit trail. Domain expertise: what clients actually say and ask for.",
        fedBy: ["commercial_strategy", "follow_up_actions", "client_proposal", "sources_used"],
        requests: ["client_highlights", "email_messages"],
      },
      {
        id: "dept_finance",
        label: "Finance",
        description: "Owns deal economics — opportunity scoring, win probability, and pricing. Domain expertise: what a deal is actually worth and what it costs to serve.",
        fedBy: ["opportunity_score", "win_probability", "pricing_recommendations"],
        requests: ["opportunity_features", "historical_tenders", "cost_matrix"],
      },
      {
        id: "dept_tech",
        label: "Tech / Risk",
        description: "Owns risk assessment and the executive composition layer. Domain expertise: which stated constraints are real blockers vs. soft gaps, and how confident the extraction actually is.",
        fedBy: ["risk_assessment", "executive_summary"],
        requests: ["tender_constraints", "constraint_catalog", "amazon_capability_profile"],
      },
    ],
  },
];

const STAGE_COLORS: Record<Stage["color"], { border: string; bg: string; text: string }> = {
  source: { border: "#232F3E", bg: "#232F3E", text: "#FFFFFF" },
  schema: { border: "#FF9900", bg: "#FFFBF0", text: "#131A22" },
  reference: { border: "#D5D9D9", bg: "#FFFFFF", text: "#131A22" },
  derived: { border: "#007185", bg: "#F0FBFC", text: "#131A22" },
  skill: { border: "#067D62", bg: "#F0FDF4", text: "#131A22" },
  department: { border: "#8B5CF6", bg: "#F5F3FF", text: "#131A22" },
};

const ALL_NODES: Record<string, ArchNode & { stageTitle: string }> = Object.fromEntries(
  STAGES.flatMap((s) => s.nodes.map((n) => [n.id, { ...n, stageTitle: s.title }])),
);

function labelFor(id: string): string {
  return ALL_NODES[id]?.label ?? id;
}

// ─── Dependency graph — edges computed once from the declarative fedBy/
// feedsInto data above, deduped regardless of which side declared them
// (skill nodes only declare fedBy, so an edge like
// commercial_strategy -> client_proposal only exists via client_proposal's
// fedBy — has to be picked up from either direction). ──────────────────────
type Edge = { from: string; to: string };

function buildEdgeList(): Edge[] {
  const seen = new Set<string>();
  const list: Edge[] = [];
  const add = (from: string, to: string) => {
    if (!ALL_NODES[from] || !ALL_NODES[to] || from === to) return;
    const key = `${from}->${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ from, to });
  };
  Object.values(ALL_NODES).forEach((node) => {
    (node.feedsInto ?? []).forEach((id) => add(node.id, id));
    (node.fedBy ?? []).forEach((id) => add(id, node.id));
  });
  return list;
}
const EDGE_LIST = buildEdgeList();

// Separate from EDGE_LIST: department -> schema/reference "retrieval
// request" edges (the requests field). Kept as its own list/rendering pass
// so it can be styled distinctly (dashed, violet, routed around the right
// margin) instead of looking like just another data-flow arrow.
function buildRequestEdgeList(): Edge[] {
  const seen = new Set<string>();
  const list: Edge[] = [];
  Object.values(ALL_NODES).forEach((node) => {
    (node.requests ?? []).forEach((id) => {
      if (!ALL_NODES[id] || id === node.id) return;
      const key = `${node.id}->${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ from: node.id, to: id });
    });
  });
  return list;
}
const REQUEST_EDGE_LIST = buildRequestEdgeList();

type Point = { x: number; y: number };
type RenderedEdge = Edge & { d: string };

// Connects whichever pair of sides ("bottom of source -> top of target" for
// the common downward flow, "right -> left" for same-row skill-to-skill
// edges, etc.) is actually closest given the two boxes' real positions —
// works regardless of how the flex-wrap layout happens to place a box.
function pathBetween(source: DOMRect, target: DOMRect): string {
  const s = { x: source.left + source.width / 2, y: source.top + source.height / 2 };
  const t = { x: target.left + target.width / 2, y: target.top + target.height / 2 };
  const dx = t.x - s.x;
  const dy = t.y - s.y;

  let from: Point;
  let to: Point;
  let vertical: boolean;
  if (Math.abs(dy) >= Math.abs(dx)) {
    vertical = true;
    from = dy >= 0 ? { x: s.x, y: source.bottom } : { x: s.x, y: source.top };
    to = dy >= 0 ? { x: t.x, y: target.top } : { x: t.x, y: target.bottom };
  } else {
    vertical = false;
    from = dx >= 0 ? { x: source.right, y: s.y } : { x: source.left, y: s.y };
    to = dx >= 0 ? { x: target.left, y: t.y } : { x: target.right, y: t.y };
  }

  if (vertical) {
    const midY = (from.y + to.y) / 2;
    return `M ${from.x} ${from.y} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y}`;
  }
  const midX = (from.x + to.x) / 2;
  return `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`;
}

// Request edges (department -> schema/reference) always loop out to the
// right margin and back, rather than using pathBetween's closest-side
// heuristic — a request edge running straight up through the middle of the
// diagram would cut across every stage in between and be indistinguishable
// from the data-flow arrows. Looping right makes "this is the upward,
// out-of-band configuration loop" visually obvious at a glance.
function requestPathBetween(source: DOMRect, target: DOMRect, containerWidth: number): string {
  const from = { x: source.right, y: source.top + source.height / 2 };
  const to = { x: target.right, y: target.top + target.height / 2 };
  const bulgeX = Math.min(Math.max(from.x, to.x) + 50, containerWidth - 4);
  return `M ${from.x} ${from.y} C ${bulgeX} ${from.y}, ${bulgeX} ${to.y}, ${to.x} ${to.y}`;
}

export default function ArchitectureDiagram() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? ALL_NODES[selectedId] : null;

  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [edges, setEdges] = useState<RenderedEdge[]>([]);
  const [requestEdges, setRequestEdges] = useState<RenderedEdge[]>([]);
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    function recompute() {
      const container = containerRef.current;
      if (!container) return;
      const containerRect = container.getBoundingClientRect();
      const toLocal = (r: DOMRect) =>
        new DOMRect(r.left - containerRect.left, r.top - containerRect.top, r.width, r.height);

      const next: RenderedEdge[] = [];
      for (const edge of EDGE_LIST) {
        const fromEl = nodeRefs.current[edge.from];
        const toEl = nodeRefs.current[edge.to];
        if (!fromEl || !toEl) continue;
        next.push({ ...edge, d: pathBetween(toLocal(fromEl.getBoundingClientRect()), toLocal(toEl.getBoundingClientRect())) });
      }
      setEdges(next);

      const nextRequests: RenderedEdge[] = [];
      for (const edge of REQUEST_EDGE_LIST) {
        const fromEl = nodeRefs.current[edge.from];
        const toEl = nodeRefs.current[edge.to];
        if (!fromEl || !toEl) continue;
        nextRequests.push({
          ...edge,
          d: requestPathBetween(toLocal(fromEl.getBoundingClientRect()), toLocal(toEl.getBoundingClientRect()), container.scrollWidth),
        });
      }
      setRequestEdges(nextRequests);

      setSvgSize({ width: container.scrollWidth, height: container.scrollHeight });
    }

    recompute();
    const ro = new ResizeObserver(recompute);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener("resize", recompute);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", recompute);
    };
  }, []);

  return (
    <div className="flex gap-6">
      <div className="flex-1">
      <div className="mb-4 flex flex-wrap items-center gap-4 rounded-md border border-border bg-surface px-3 py-2 text-xs text-gray-600">
        <span className="flex items-center gap-1.5">
          <svg width="20" height="8" aria-hidden="true"><line x1="0" y1="4" x2="20" y2="4" stroke="#B8BEC2" strokeWidth="2" /></svg>
          Data flow (source → skill)
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="20" height="8" aria-hidden="true"><line x1="0" y1="4" x2="20" y2="4" stroke="#8B5CF6" strokeWidth="2" strokeDasharray="4 3" /></svg>
          Retrieval request — a department telling the engine what to prioritize (the upward loop)
        </span>
        <span className="flex items-center gap-1.5">⚙ Configurable via that skill's SKILL.md (planned, per department)</span>
      </div>
      <div ref={containerRef} className="relative space-y-8">
        <svg
          className="pointer-events-none absolute left-0 top-0"
          width={svgSize.width}
          height={svgSize.height}
          style={{ overflow: "visible" }}
          aria-hidden="true"
        >
          <defs>
            <marker id="arrow-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#FF9900" />
            </marker>
            <marker id="arrow-idle" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#B8BEC2" />
            </marker>
            <marker id="arrow-request" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#8B5CF6" />
            </marker>
          </defs>
          {edges.map((e) => {
            const active = selectedId ? e.from === selectedId || e.to === selectedId : false;
            return (
              <path
                key={`${e.from}->${e.to}`}
                d={e.d}
                fill="none"
                stroke={active ? "#FF9900" : "#B8BEC2"}
                strokeWidth={active ? 2 : 1.25}
                opacity={selectedId ? (active ? 1 : 0.15) : 0.45}
                markerEnd={active ? "url(#arrow-active)" : "url(#arrow-idle)"}
                className="transition-opacity duration-150"
              />
            );
          })}
          {requestEdges.map((e) => {
            const active = selectedId ? e.from === selectedId || e.to === selectedId : false;
            return (
              <path
                key={`request-${e.from}->${e.to}`}
                d={e.d}
                fill="none"
                stroke="#8B5CF6"
                strokeWidth={active ? 2 : 1.25}
                strokeDasharray="5 4"
                opacity={selectedId ? (active ? 1 : 0.12) : 0.55}
                markerEnd="url(#arrow-request)"
                className="transition-opacity duration-150"
              />
            );
          })}
        </svg>

        {STAGES.map((stage) => {
          const colors = STAGE_COLORS[stage.color];
          return (
            <div key={stage.title}>
              <h2 className="text-sm font-bold text-ink">{stage.title}</h2>
              <p className="mb-3 text-xs text-gray-500">{stage.subtitle}</p>
              <div className="flex flex-wrap gap-3">
                {stage.nodes.map((node) => {
                  const isSelected = selectedId === node.id;
                  const isDimmed = !!selectedId && !isSelected && ![...edges, ...requestEdges].some(
                    (e) => (e.from === node.id && e.to === selectedId) || (e.to === node.id && e.from === selectedId),
                  );
                  return (
                    <button
                      key={node.id}
                      ref={(el) => { nodeRefs.current[node.id] = el; }}
                      onClick={() => setSelectedId(node.id)}
                      className="relative min-w-[180px] max-w-[260px] flex-1 rounded-md border-2 p-3 text-left transition-[box-shadow,opacity] hover:shadow-md"
                      style={{
                        borderColor: isSelected ? "#FF9900" : colors.border,
                        background: colors.bg,
                        color: colors.text,
                        boxShadow: isSelected ? "0 0 0 2px #FF9900" : undefined,
                        opacity: isDimmed ? 0.4 : 1,
                      }}
                    >
                      {node.skillMdPath ? (
                        <span
                          className="absolute right-2 top-2 text-xs opacity-70"
                          title={`Configurable via ${node.skillMdPath} (planned, not yet implemented)`}
                        >
                          ⚙
                        </span>
                      ) : null}
                      <p className="pr-4 text-sm font-bold leading-snug">{node.label}</p>
                      {node.subtitle ? (
                        <p className="mt-0.5 text-xs opacity-70">{node.subtitle}</p>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      </div>

      <aside className="sticky top-6 h-fit w-80 flex-shrink-0 rounded-md border border-border bg-surface p-5">
        {!selected ? (
          <div className="text-sm text-gray-400">
            <p className="font-semibold text-gray-500">Click any box</p>
            <p className="mt-1">
              Every node is a real table (or skill) from the actual schema —
              click one to trace its connector lines to what feeds it and
              what it feeds into, and see its details here.
            </p>
          </div>
        ) : (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-orange-dark">{selected.stageTitle}</p>
            <h3 className="mt-1 text-base font-bold text-ink">{selected.label}</h3>
            <p className="mt-2 text-sm text-gray-700">{selected.description}</p>

            {selected.columns ? (
              <div className="mt-4">
                <p className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">Key columns</p>
                <div className="flex flex-wrap gap-1.5">
                  {selected.columns.map((c) => (
                    <span key={c} className="rounded border border-border bg-canvas px-1.5 py-0.5 font-mono text-xs text-gray-700">
                      {c}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {selected.fedBy?.length ? (
              <div className="mt-4">
                <p className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">Fed by</p>
                <ul className="space-y-1">
                  {selected.fedBy.map((id) => (
                    <li key={id}>
                      <button
                        onClick={() => setSelectedId(ALL_NODES[id] ? id : selectedId)}
                        className={"text-sm " + (ALL_NODES[id] ? "text-link hover:underline" : "text-gray-500")}
                      >
                        ← {labelFor(id)}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {selected.feedsInto?.length ? (
              <div className="mt-4">
                <p className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">Feeds into</p>
                <ul className="space-y-1">
                  {selected.feedsInto.map((id) => (
                    <li key={id}>
                      <button
                        onClick={() => setSelectedId(ALL_NODES[id] ? id : selectedId)}
                        className={"text-sm " + (ALL_NODES[id] ? "text-link hover:underline" : "text-gray-500")}
                      >
                        {labelFor(id)} →
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {selected.requests?.length ? (
              <div className="mt-4">
                <p className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">
                  Requests retrieval prioritize (upward)
                </p>
                <ul className="space-y-1">
                  {selected.requests.map((id) => (
                    <li key={id}>
                      <button
                        onClick={() => setSelectedId(ALL_NODES[id] ? id : selectedId)}
                        className={"text-sm " + (ALL_NODES[id] ? "text-link hover:underline" : "text-gray-500")}
                      >
                        ↑ {labelFor(id)}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {selected.skillMdPath ? (
              <div className="mt-4 rounded-sm border border-dashed border-border bg-canvas p-3 text-xs text-gray-600">
                <p className="mb-1 font-bold uppercase tracking-wide text-gray-500">⚙ Configurable</p>
                <p>
                  Defined in <code className="font-mono text-gray-800">{selected.skillMdPath}</code> —
                  owned by{" "}
                  {selected.ownedByDept ? (
                    <button
                      onClick={() => setSelectedId(selected.ownedByDept!)}
                      className="text-link hover:underline"
                    >
                      {labelFor(selected.ownedByDept)}
                    </button>
                  ) : (
                    "an unassigned department"
                  )}
                  . Planned: editable by that department's workflow owner, based on how their team
                  actually works. Not yet implemented; today it's a fixed file read by the skill script.
                </p>
              </div>
            ) : null}
          </div>
        )}
      </aside>
    </div>
  );
}
