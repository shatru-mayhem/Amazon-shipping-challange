# Figma Make Dashboard → Backend Mapping Report

**What this is:** `dashboard_with_figmaMake/` is a **standalone Vite + React
SPA** (not part of the Next.js app — separate `package.json`, own
`vite.config.ts`, no Next.js). It's a single 892-line `src/app/App.tsx` built
entirely against a hardcoded `MOCK_DASHBOARD` object and a 3-item fake
`OPPORTUNITIES` list. **No fetch calls, no real data, no auth** — it's a
pure visual prototype generated from `UI_DASHBOARD_REDESIGN_SPEC.md`. The
`components/ui/*` shadcn primitives it scaffolded (button, card, dialog,
etc.) are unused — `App.tsx` builds everything with raw divs and inline
`style={{...}}` instead.

This report maps every piece of it to the real backend so it can actually be
wired up, and flags where it drifted from spec or from the real data shapes.

---

## 1. Data mapping — mock fields → real source

### `executive_summary`
| Mock field | Real source | Note |
|---|---|---|
| `has_hard_blocker`, `hard_blockers` | `executive_summary.has_hard_blocker` / `.hard_blockers` (skills/executive_summary.py) | matches |
| `score_band`, `risk_level`, `win_probability` | **does not exist on `executive_summary`** — these are `opportunity_score.band`, `risk_assessment.overall_risk`, `win_probability.win_probability` respectively | mock flattened 3 separate skill outputs into one object; real integration needs to pull from 3 different `Dashboard` keys |
| `decision_prompt`, `headline` | `executive_summary.decision_prompt` / `.headline` | matches |

### `opportunity_score` — matches real shape (`score`, `band`, `rationale`) exactly.

### `risk_assessment`
| Mock | Real | Note |
|---|---|---|
| `risks[].severity`, `.title`, `.hard_blocker` | `risk_assessment.risks[]` — real also has `.category`, `.detail` | mock drops `category`/`detail`, which the current live dashboard displays |
| `overall_risk`, `risk_count` | matches | — |

### `pricing_recommendations` — **biggest mismatch.** Mock schema is stale (built against an earlier pricing schema, before the recent `price_per_package_eur`/`contract_value_eur` rework — see `lib/dashboard-types.ts`).

| Mock field | Real field (`lib/dashboard-types.ts` `PricingScenario`) |
|---|---|
| `s.price` (string, e.g. `"$2.1M"`) | `price_per_package_eur` (number), `contract_value_eur` (number\|null), `daily_revenue_eur` (number) — no single pre-formatted price string exists |
| `s.guardrail_result: "pass" \| "warn"` | real values are `"within_target" \| "above_min_below_target" \| "requires_vp_approval" \| "auto_no_go"` — different enum entirely, needs new tone mapping |
| `data.recommended` | real key is `recommended_scenario` |
| `data.guardrail_notes` | real key is `guardrails` |
| — | real also has `discount_pct_vs_list`, `volume_packages_per_day`, `total_cost_per_package_eur`, `region_multiplier_applied`, `regions_priced`, `regions_without_cost_data`, `error` — none rendered in the mock |

### `commercial_strategy`
| Mock | Real |
|---|---|
| `objections` | real key is `objections_to_preempt` |
| `client_priorities` | real key is `align_to_priorities` |
| `capability_gaps[].title` | real is `capability_gaps_to_flag[]` with `constraint_name`, `result`, `severity`, `gap_description`, `is_hard_blocker` — mock collapsed all of that into one `title` string and lost severity/hard-blocker styling that the live dashboard currently has |
| `has_hard_blocker`, `positioning_statement`, `lead_with_strengths`, `negotiation_approach` | match |

### `follow_up_actions`
| Mock `actions[].text` | Real key is `.action` (and real also has `.detail`, `.type` — used by the live dashboard to detect `type === "hard_blocker_escalation"` for red styling, which the mock's `FollowUpActionsPanel` doesn't replicate) |

### `client_proposal` — **structurally different from real data.**
- Mock: flat `slides: string[]` (7 plain title strings, no body content).
- Real: `sections.{cover, understanding_your_needs, why_amazon_shipping, commercial_proposal, next_steps}` (see `lib/dashboard-types.ts` `ClientProposal`), and the **actual 7 slides with real bullet content** are already computed by `lib/build-pitch-deck.ts`'s `buildPitchDeckSlides()` — this function already exists and already produces `{title, bullets}[]`. The mock's `PitchDeckPanel` reinvents a simplified version of `components/PitchDeckPanel.tsx` (which already handles hard-blocker-gated download + real pptxgenjs export) — **don't hand-port this panel, replace it outright with the existing component.**

### `win_probability` — mostly matches (`win_probability`, `base_rate`, `rationale`); mock's `drivers[].type: "win"|"loss"` corresponds to real `top_drivers[].effect` (positive/negative number, not a string enum) — needs a `effect >= 0 ? "win" : "loss"` translation.

### `sources_used`
| Mock | Real |
|---|---|
| `challenge_documents: string[]` | real is `challenge_documents: {filename, source_type}[]` — objects, not plain strings |
| `email_count`, `constraint_count` | real is nested: `email_correspondence.{threads, messages}`, `extracted_evidence.tender_constraints_extracted` |
| `internal_refs[].{key, rows, used_by}` | real is `internal_reference_data: Record<string, {total, used_by[]} | string | null>` — a map, not an array, and `used_by` is a string array not a joined string |

### `OPPORTUNITIES` (3 hardcoded fake companies)
Real source: `listOpportunitiesForIngestion()` in `app/actions/tender_ingestion.ts`, returning `{opportunity_id, customer_name, title}[]` from the live DB (e.g. the real "Pink Papaya" opportunity used to test the hard-blocker flow). The mock's `{id, label}` shape needs remapping.

---

## 2. Component-by-component mapping

| Prototype piece | Real backend / existing component to wire it to |
|---|---|
| `TopBar` mode toggle | New — no existing component, straightforward to port as-is (pure UI state, `mode` in local state or route) |
| `ExecutiveMode` sidebar + "Load Dashboard" | `SKILL_LOAD_ORDER` + `callSkill()` loop already implemented in `components/ExecutiveDashboard.tsx` — port that fetch logic in, don't reimplement |
| 8 category panels (`ExecutiveSummaryPanel`, `OpportunityScorePanel`, etc.) | Rewrite each against real `Dashboard` type fields per §1 above; existing `ExecutiveDashboard.tsx` already has working JSX for every one of these — reuse its markup/logic, restyle to match the new visual design instead of writing from scratch |
| `PitchDeckPanel` (mock) | **Replace entirely** with the real `components/PitchDeckPanel.tsx` + `lib/build-pitch-deck.ts` — already fetches real data, already has the hard-blocker acknowledgment gate, already exports a real `.pptx` via pptxgenjs |
| `ChatPanel` | Frontend-only shell exists and matches `UI_DASHBOARD_REDESIGN_SPEC.md` §5 reasonably well (message threads per context, suggested questions, typing indicator) — **no backend exists for this at all**; needs an actual chat endpoint before it does anything beyond the canned "no LLM connected yet" reply |
| `EmployeeMode` flow diagram | Entirely new visualization, not in the spec or in any existing component — see §3 below, needs a decision on real data source |
| `SourcesFooter` | Reasonable idea not in the original spec (spec put Sources Used as its own 9th nav item) — real data via `sources_used`, same mapping as §1 |

---

## 3. Deviations from the agreed spec / decisions needed

1. **"Sources Used" isn't its own nav item.** `NAV_ITEMS` only has 8 entries — Sources Used got turned into a `SourcesFooter` appended under every panel instead of the 9th sidebar item the spec called for. Need a decision: keep as a footer (arguably better UX) or restore as its own nav entry.
2. **Chat is a permanently-docked right sidebar (`w-72`, always visible)**, not the floating-button → slide-in drawer you chose in the earlier design decision. Main content area is already squeezed (`ml-56 mr-72`) to make room for it permanently. This is the bigger of the two structural deviations — worth deciding whether to keep the always-on panel (simpler, more "real dashboard" feel) or rebuild as the toggleable drawer originally specced.
3. **Chat also appears in Employee Mode**, contradicting the spec (`§6`: "chat is an Executive-mode-only feature").
4. **Employee mode is a visual pipeline/flow diagram** (two parallel nodes → merge → retrieval → capability, with a progress bar), not the spec's "single-column stack of the 4 existing panels, restyle only." This is a nicer visualization but a real redesign, not a restyle — the 4 real panels (`TenderUploadPanel`, `EmailImportPanel`, `RetrievalStatusPanel`, `CapabilityIngestionPanel`) each have real upload/select/status logic (file inputs, polling, approve/reject actions) that this flow diagram doesn't have anywhere — it's decorative only right now. Needs a decision: keep the 4 functional panels and layer this diagram on top as a status overview, or replace the diagram's mock status data with real polling from `RetrievalStatusPanel`'s existing logic.
5. **Sidebar nav badges are hardcoded** (`getBadge()` always returns "3" for risk, "4" for follow-ups) rather than reading `data.risk_count` / `data.open_action_count` — trivial fix once real data flows in.

---

## 4. Integration path (what actually has to happen)

This prototype is a separate app; it can't just be "connected" — the visual
design needs to be ported into the existing Next.js codebase (or the Next.js
app's data-fetching needs porting into this Vite app — not recommended,
since auth/middleware/API routes are Next.js-specific and already working).
Recommended direction:

1. Port `App.tsx`'s JSX/layout into `components/ExecutiveDashboard.tsx` and a
   new `components/EmployeeMode.tsx`, replacing the mock data reads with the
   real `Dashboard` state object already fetched there.
2. Replace the mock `PitchDeckPanel` wholesale with the real
   `components/PitchDeckPanel.tsx` (already correct).
3. Replace `OPPORTUNITIES` with `listOpportunitiesForIngestion()`.
4. Resolve the two structural deviations in §3 (chat placement, employee
   mode content) before porting, since they change the layout grid.
5. Chat has no backend — decide whether it ships as a visual-only "coming
   soon" state or gets a real endpoint before launch.

---

## 5. Summary

The prototype is faithful to the spec's visual language (colors, card
style, states) and got the overall shape right (sidebar + single-panel
content + chat), but: pricing/commercial-strategy/sources data shapes are
stale relative to the real API, the pitch deck panel should be swapped for
the real one outright, and two structural decisions (chat placement,
employee-mode content) diverged from what was agreed and need a call before
this gets wired to real data.
