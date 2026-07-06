# ASCS Dashboard Redesign — UI Design Specification

**Purpose:** Restructure the current single-scroll Executive Dashboard into a
proper multi-panel dashboard with two modes (Employee / Executive), a
category-based navigation model, and a contextual AI chat drawer. This
document is written for an AI design engine (Figma Make) to parse directly —
every state, input, and action is spelled out explicitly. Frontend only; no
backend/chat logic is specified here.

**Grounding:** all data fields referenced below come from the real API
response shapes already implemented in `lib/dashboard-types.ts` (fetched via
`/api/skill` → `skills/*.py`). Brand tokens come from `tailwind.config.ts`.
Nothing in this spec invents new data — only new layout/composition of
existing data.

---

## 1. Global Design Tokens (already defined, reuse exactly)

| Token | Value | Usage |
|---|---|---|
| `ink` | `#131A22` | Header background, primary body text on light surfaces |
| `navy` | `#232F3E` | Secondary surfaces, sidebar background, title slide bg |
| `orange` | `#FF9900` | Primary action buttons, active nav indicator, accents |
| `orange-dark` | `#E88B00` | Primary button hover |
| `link` / `link-dark` | `#007185` / `#005A6E` | Inline links, info badges |
| `surface` | `#FFFFFF` | Card backgrounds |
| `canvas` | `#F3F4F6` | Page background |
| `border` | `#D5D9D9` | Card/input borders |
| `success` / `warning` / `danger` | `#067D62` / `#B45309` / `#B12704` | Status badges (existing `StatusBadge` component, tones: success/warning/danger/info/neutral) |
| Font | Amazon Ember → Arial → Helvetica → sans-serif | All text |
| Radius | `sm=4px`, `DEFAULT=6px`, `md=8px` | Buttons=sm/DEFAULT, cards=md |

Spacing scale: Tailwind default (4px increments) — `p-3` (12px) for compact
cards, `p-5` (20px) for section cards, `gap-4`/`gap-6` between grid items,
matching what's already used across `ExecutiveDashboard.tsx`.

---

## 2. Information Architecture

```
/employee                → Employee Mode (ingestion pipeline only)
/employee/dashboard       → Executive Mode (all 9 outputs + pitch deck + chat)
```

A **manual mode toggle** (not role-gated) lives in the shared top bar and
switches between the two routes/views for any logged-in employee — this
mirrors the existing "Hierarchy level (demo switch)" pattern already in
`app/employee/page.tsx`, just promoted to a primary navigation control.

---

## 3. Shared Top Bar (extends existing `TopBar.tsx`)

**Layout:** single-row flex header, full-width, background `ink`, height `56px` (`h-14`), horizontal padding `16px` (`px-4`), max content width `1280px` (`max-w-7xl`) centered.

**Elements, left to right:**
1. Amazon Supply Chain Services wordmark (existing, unchanged) — text logo, no image asset.
2. Context pill (existing `context` prop) — small `navy`-bordered badge, e.g. "Executive Dashboard".
3. **New: Mode Toggle** — a two-segment pill control, immediately right of the context pill:
   - Segment A: "Employee" — icon: inbox/upload glyph.
   - Segment B: "Executive" — icon: chart/dashboard glyph.
   - **Default state:** whichever route the user is currently on is visually active (`bg-orange text-ink`, other segment `text-gray-300` on `navy` background).
   - **Hover state (inactive segment):** `bg-navy/60`.
   - **Click action:** client-side route push to `/employee` or `/employee/dashboard`. No confirmation dialog — instant navigation.
4. Right-aligned: "Sign out" link (existing, unchanged) or "Internal preview — sample data" note when `showBack` is false.

---

## 4. Executive Mode Layout (`/employee/dashboard`)

### 4.1 Page grid

**Layout type:** Two-column responsive grid layout below the top bar, full-height (`min-h-[calc(100vh-56px)]`).

```
+------------------------------------------------------------------+
| TopBar (56px, fixed)                                             |
+------------+-------------------------------------------------------+
|            |                                                       |
| Sidebar    |   Main Content Area                                  |
| Nav        |   (active category only — single-panel, not scroll)  |
| (240px,    |                                                       |
|  fixed)    |                                                       |
|            |                                                       |
+------------+-------------------------------------------------------+
                                                        [💬] <- floating
                                                            action button,
                                                            bottom-right,
                                                            fixed position
```

- **Sidebar:** fixed width `240px`, background `surface`, right border `1px solid border`, full viewport height, sticky/fixed on scroll.
- **Main content area:** flexible width (`flex-1`), background `canvas`, padding `24px` (`p-6`), scrollable independently of the sidebar.
- **Chat button:** `56x56px` circular, `bg-orange`, fixed position `bottom: 24px; right: 24px`, `z-index` above all content. Persists across category switches.

### 4.2 Sidebar Navigation

**Header block (top of sidebar, before nav items):**
- Opportunity picker: a `<select>` dropdown, full sidebar width minus padding, label "Opportunity" above it, listing `customer_name — title` per option (reuses existing `listOpportunitiesForIngestion` data).
- Primary button below it: "Load Dashboard" (`bg-orange`, full width, height `44px` / `h-11`).
- **Loading state:** button text becomes "Loading {category name}…", disabled, reduced opacity (`disabled:opacity-60`) — matches existing `pending`/`progress` state pattern already in `ExecutiveDashboard.tsx`.
- **Error state:** if `listOpportunitiesForIngestion` fails, render a `danger`-toned inline message below the picker instead of the dropdown (existing `oppsError` pattern).

**Nav item list** (below the header block, one row per category, in this exact order):

| # | Nav label | Source data | Badge (if applicable) |
|---|---|---|---|
| 1 | Executive Summary | `executive_summary` | `danger` badge "⚠" if `has_hard_blocker` |
| 2 | Opportunity Score | `opportunity_score` | `bandTone` colored dot (hot=success/warm=warning/cold=neutral) |
| 3 | Risk Assessment | `risk_assessment` | `danger` badge with `risk_count` if `overall_risk !== "none"` |
| 4 | Pricing Recommendation | `pricing_recommendations` | none |
| 5 | Commercial Strategy | `commercial_strategy` | `danger` dot if `has_hard_blocker` |
| 6 | Required Follow-Up Actions | `follow_up_actions` | numeric badge = `open_action_count` (hidden if 0) |
| 7 | Client Proposal / Pitch Deck | `client_proposal` + `PitchDeckPanel` | `danger` badge "⚠" if `internal_flags.has_hard_blocker` |
| 8 | Win Probability Score | `win_probability` | none |
| 9 | Sources Used | `sources_used` | none |

**Nav item states:**
- **Default:** `text-ink`, transparent background, `40px` row height, left padding `16px`, `14px` font.
- **Hover:** `bg-canvas`.
- **Active (currently open category):** `bg-navy text-white`, left border accent `3px solid orange`.
- **Disabled (before "Load Dashboard" has been clicked):** all 9 items `text-gray-400`, not clickable, cursor `not-allowed`. Only becomes clickable once dashboard data exists.
- **Per-item loading:** if lazy-fetching per-category (see §4.4), show a small spinner icon to the right of the label while that specific category's data is in flight.

### 4.3 Main Content Area — per-category panels

Only **one category's panel is rendered at a time**, selected by the active
sidebar item (not a long scroll — this is the core change from the current
implementation). Each panel has this structure:

**Panel header (every category):**
- `h1`-style title matching the nav label, `20px bold`, `text-ink`.
- Right-aligned: contextual action(s) if any (e.g. "Download .pptx" only appears in the Pitch Deck panel header).

**Panel body:** category-specific, detailed below. All panels sit inside a
`surface`-background card, `rounded-md` (`8px`), `p-5` (`20px` padding),
`border border-border`.

#### 4.3.1 Executive Summary
- Full-width banner card, background `navy` (or `bg-red-950` if hard blocker — reuse exact existing logic from current `ExecutiveDashboard.tsx`).
- If `has_hard_blocker`: red-bordered inset box "⚠ Hard blocker — Amazon cannot change this" listing `hard_blockers[].title`.
- Badge row: score band, risk level, win probability % — reuse existing `StatusBadge` row.
- `decision_prompt` in bold, `headline` below in muted gray.

#### 4.3.2 Opportunity Score
- Single stat card: large number `score/100` (`32px bold`), `StatusBadge` for band next to it, `rationale` text below.

#### 4.3.3 Risk Assessment
- List of risk items, each a row: `StatusBadge` (severity → category), risk `title`. Rows with `hard_blocker: true` get a `danger`-bordered background and a leading "HARD BLOCKER" badge.
- **Empty state:** "No operational, commercial, or financial risks identified from current data." (muted gray, no icon).

#### 4.3.4 Pricing Recommendation
- 3-column responsive grid (stacks to 1 column below `768px`), one card per scenario (`aggressive` / `balanced` / `premium`).
- Recommended scenario card gets `border-orange bg-orange/10` highlight.
- Each card: scenario name (uppercase, bold, small), `guardrail_result` badge, `target_margin_pct%` (large), price/margin detail line, `rationale`, `tradeoffs`, `negotiation_strategy`.
- Guardrail notes list below the grid (`warning`-toned text lines).
- **Error/empty state:** "Not enough data to price this opportunity yet." if `scenarios.length === 0`.

#### 4.3.5 Commercial Strategy
- Two-column responsive grid (stacks below `768px`):
  - Left: `positioning_statement`, "Lead with" bullet list (`lead_with_strengths`), "Objections to pre-empt" bullet list.
  - Right: "Align to client priorities" bullet list, "Capability gaps to flag" list (hard-blocker rows get `danger` styling, same pattern as Risk Assessment), `negotiation_approach` note at the bottom, separated by a top border.
- **Empty state:** "Not enough client/competitive data yet to recommend a strategy."

#### 4.3.6 Required Follow-Up Actions
- List of action rows: `StatusBadge` (priority), action text. `type === "hard_blocker_escalation"` rows get the same `danger`-bordered hard-blocker treatment.
- **Empty state:** "No open questions, meetings, or validations required — clear to proceed."

#### 4.3.7 Client Proposal / Pitch Deck
- This panel embeds the existing `PitchDeckPanel` component as-is:
  - Hard-blocker warning banner + acknowledgment checkbox (existing behavior) if `internal_flags.has_hard_blocker`.
  - 4-column responsive grid (stacks to 2 col / 1 col) of 7 slide preview cards (`aspect-video`), slide 1 styled `navy`/white, rest `surface`/`border`.
  - Primary button "Download .pptx" in the panel header area (per §4.3 panel header spec), disabled until acknowledgment checkbox is checked when a hard blocker exists.

#### 4.3.8 Win Probability Score
- Single stat card: `win_probability%` large, `base_rate%` comparison text next to it, `rationale` below.
- "Top drivers" list: each driver a row with a `success`/`danger` badge ("win factor"/"loss factor") + `factor` text.
- **Empty state:** "No win/loss signals checked yet — probability is the historical base rate."

#### 4.3.9 Sources Used
- Two-column grid: left = challenge documents list + email/constraint counts; right = internal reference data table (`key: total row(s) — used by X, Y`).

### 4.4 Data loading model

- Clicking **"Load Dashboard"** triggers all 9 skill fetches in sequence (existing `SKILL_LOAD_ORDER` behavior, unchanged) — the sidebar progress label shows which one is currently loading.
- Once loaded, category switching is **instant** (all 9 results are already in memory as the existing `Dashboard` state object) — no per-click network request.
- **Loading state (initial):** sidebar nav items are disabled/grayed per §4.2; main content area shows a centered spinner + "Loading {current skill name}…" text on `canvas` background.
- **Error state:** if a given skill's fetch fails (`callSkill` returns `null`), that category's panel renders its existing "not enough data" / empty-state copy rather than crashing — same defensive-default pattern already in the code (`?? { ...fallback }`).

---

## 5. Contextual Chat Drawer

**Trigger:** floating circular button (`💬`, `56px`, `bg-orange`, fixed bottom-right, `z-40`).

**Button states:**
- **Default:** solid `orange`, subtle shadow.
- **Hover:** `bg-orange-dark`, slight scale (`1.05`).
- **Active/open:** button shows a close "✕" glyph instead of "💬" while drawer is open.
- **Unread indicator (optional, future):** small dot badge, top-right of the button — not required for v1.

**Drawer layout:** slides in from the right edge, width `380px`, full viewport height minus top bar, `surface` background, `border-l border-border`, box-shadow on the left edge, overlapping the main content (does not resize it).

**Drawer header:**
- Title: "Ask about {active category name}" — dynamically updates to whichever sidebar category is currently open (e.g. "Ask about Pricing Recommendation"). This is the contextual binding: the drawer always reflects the main content area's active category, updating live if the user switches categories while the drawer is open.
- Close button (`✕`) top-right.

**Drawer body states:**
- **Default (no messages yet):** centered placeholder text: "Ask a question about the {category name} shown on the left." + 2-3 suggested-question chips specific to the category (e.g. for Pricing Recommendation: "Why is the balanced scenario recommended?", "What's the guardrail floor here?"). Chips are `border-border` pill buttons, clicking one populates the input (does not auto-send).
- **Message list:** standard chat bubbles — user messages right-aligned `bg-orange/10`, assistant messages left-aligned `bg-canvas`, both `rounded-md`, `text-sm`, max-width `85%` of drawer.
- **Loading (assistant responding):** three-dot typing indicator bubble, left-aligned, same style as assistant bubble.
- **Error state:** inline `danger`-toned bubble: "Couldn't get a response — try again." with a small "Retry" text button.
- **Input area (bottom, sticky):** single-line auto-growing textarea, placeholder "Ask about {category name}…", `border-border`, full drawer width minus padding; send button (`bg-orange`, icon-only, `44x44px` touch target) to its right, disabled when input is empty or while a response is streaming.

**Context switching behavior:** if the user switches sidebar category while the drawer is open, the conversation history is **preserved per category** (each category keeps its own thread — switching back to a previously-chatted-about category restores that thread rather than starting over). The drawer header title and suggested-question chips update to match the newly active category.

*(No backend/LLM wiring is specified here — this section only defines the UI shell, states, and interaction contract a chat feature would need to satisfy.)*

---

## 6. Employee Mode Layout (`/employee`)

**Scope:** ingestion pipeline only — `TenderUploadPanel`, `EmailImportPanel`, `RetrievalStatusPanel`, `CapabilityIngestionPanel`. Team, Knowledge, Q&A bar, document review folders, and the mock pipeline view move out of this page (either dropped from v1 or relocated to Executive mode in a later pass — not specified here).

**Layout type:** single-column stacked list, no sidebar, no chat drawer (chat is an Executive-mode-only feature per this spec).

```
+------------------------------------------------------+
| TopBar (with mode toggle set to "Employee")           |
+------------------------------------------------------+
|  Opportunity picker (shared across all 4 panels)      |
+------------------------------------------------------+
|  Tender Document Upload         [Section card]        |
+------------------------------------------------------+
|  Email / CRM Import             [Section card]        |
+------------------------------------------------------+
|  Retrieval Status                [Section card]        |
+------------------------------------------------------+
|  Capability Update Ingestion     [Section card]        |
+------------------------------------------------------+
```

Each panel keeps its existing internal behavior (file input, select dropdown,
upload button, status/progress list) unchanged — this is a **restyle only**:
wrap each in the same card style (`surface`, `rounded-md`, `border-border`,
`p-5`) used across Executive mode for visual consistency, max content width
`1280px` centered, `24px` vertical gap between panel cards.

---

## 7. Component States Matrix (quick-reference for the design engine)

| Component | Default | Loading | Success | Error | Empty |
|---|---|---|---|---|---|
| Mode toggle | active segment highlighted | — | — | — | — |
| Opportunity picker | populated dropdown | disabled, "Loading…" | populated | inline `danger` text replaces dropdown | "No opportunities found." |
| Load Dashboard button | enabled, `bg-orange` | disabled, "Loading {skill}…" | — | — | — |
| Sidebar nav item | enabled after load | spinner icon (per-item, if lazy) | badge reflects data | — | badge omitted |
| Category panel | — | centered spinner | populated per §4.3 | fallback empty-copy (defensive default) | category-specific empty copy (see §4.3.x) |
| Chat button | `bg-orange` circle | — | — | — | — |
| Chat drawer | closed | typing indicator bubble | message bubbles | error bubble + Retry | suggested-question chips |
| Pitch Deck download button | enabled | — | file downloads | — | disabled until hard-blocker checkbox acknowledged |

---

## 8. Out of scope for this spec

- Chat backend/LLM wiring (frontend contract only, per §5).
- Role-based access control changes (mode toggle is manual per user's decision, existing `middleware.ts` role routing is untouched).
- Mobile-specific breakpoints below `768px` beyond the stacking behavior already noted per grid (this is an internal desktop-first tool).
- Changes to the 4 ingestion panels' internal logic (upload flow, retrieval status polling, capability approval) — restyle only.
