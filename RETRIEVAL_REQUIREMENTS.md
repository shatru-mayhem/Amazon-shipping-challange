# Retrieval Requirements Matrix

Derived by working backwards from the 8 skills (per whiteboard flow) to their
declared `Data source` sections. Goal: the retrieval/extraction engine only
ever targets these fields — nothing is extracted "because it might be
useful."

## Step 0 — sort every downstream input by whether it needs extraction at all

Most tables a skill reads are **not** retrieval targets — they're either
internal Amazon data that already exists, or pure computation over fields
that *are* extraction targets.

| Table | Needs extraction? | Why |
|---|---|---|
| `historical_tenders`, `cost_matrix`, `amazon_capability_profile`, `constraint_catalog`, `win_loss_signal_catalog` | No | Internal Amazon reference data — already curated, not client-sourced. |
| `constraint_compliance_results`, `signal_check_results` | No | Pure rule computation over `tender_constraints`/`opportunity_features` vs. the internal tables above. Zero NLP. |
| `opportunity_features` | **Yes** | Structured fields stated in the tender contract. |
| `tender_constraints` | **Yes** | Constraint statements in the tender contract, matched to `constraint_catalog`. |
| `client_highlights` | **Yes** | Pains/priorities/objectives — from tender docs *and* emails. |
| `email_messages` (+ `resolved` flag) | **Yes** | From the CRM/email system (separate source from the tender). |

So the retrieval engine has exactly **4 targets**, not "the whole document."

## Step 1 — skill → field → origin

| Skill | Field it consumes | Source table | Origin | Extraction type |
|---|---|---|---|---|
| pricing_recommendations | `volume`, `requested_discount_pct` | opportunity_features | tender contract | structured field |
| pricing_recommendations | `estimated_value` | opportunities | tender contract (deal-level, likely CRM-entered) | structured field |
| commercial_strategy | `incumbent_provider`, `requested_discount_pct` | opportunity_features | tender contract | structured field |
| commercial_strategy | pains, priorities, growth objectives | client_highlights | tender docs + emails | free-text classification |
| commercial_strategy | satisfied constraints (proof points) | constraint_compliance_results | *derived* (needs tender_constraints as input) | — |
| risk_assessment | requested_discount_pct, field_confidence | opportunity_features | tender contract | structured field + confidence |
| risk_assessment | unsatisfied/unclear constraints | constraint_compliance_results | *derived* | — |
| win_probability | signal status | signal_check_results | *derived* (maps to an opportunity_features column) | — |
| opportunity_score | estimated_value | opportunities | tender contract | structured field |
| follow_up_actions | unresolved inbound questions | email_messages | email/CRM | thread resolution (semantic: does a later msg answer an earlier question?) |
| follow_up_actions | unclear constraints | constraint_compliance_results | *derived* | — |
| client_proposal | everything above, composed | — | — | — |
| executive_summary | everything above, composed | — | — | — |

## Step 2 — the actual retrieval engine scope

Because the two upstream sources are **two separate companies' systems**
(client tender/contract docs vs. Amazon-side email/CRM), the engine is two
pipelines writing into a shared schema, not one indiscriminate extractor:

**Pipeline A — tender contract → structured fields**
- Target: `opportunity_features` (volume, lanes, geography, industry_vertical,
  contract_length_months, required_sla_hours, incumbent_provider,
  requested_discount_pct) + per-field `field_confidence`.
- Target: `tender_constraints` — stated constraint text + `stated_value`,
  matched to a `constraint_catalog` row.
  - **This is the one place semantic/embedding retrieval earns its keep**:
    matching free-text constraint wording ("must deliver to mainland Spain
    within 48h") to the right `constraint_catalog` entry (Geography /
    Delivery speed) via embedding similarity against catalog descriptions —
    not a hard-constraint check itself (that's the deterministic step
    already discussed), just the *classification* of which catalog row a
    given sentence belongs to.
- Also produces `client_highlights` rows sourced from the same document
  (pain points, priorities stated in the tender).

**Pipeline B — email/CRM → correspondence state**
- Target: `email_messages`/`email_threads` ingestion + `resolved` flag.
- Target: `client_highlights` rows sourced from email (past complaints,
  stated priorities mentioned in correspondence, not just the tender doc).
- The `resolved` flag and "does this later message answer that earlier
  open question" is also a semantic-matching problem, same embedding
  approach as constraint classification, applied to a different corpus.

## Step 3 — what this rules out

- No generative LLM required anywhere in retrieval. Structured field
  extraction is either regex/rule-based (numbers, dates, enumerated lists)
  or a small extraction model; constraint/complaint *classification* is
  embedding similarity against a fixed catalog (`constraint_catalog`,
  `win_loss_signal_catalog` categories); thread resolution is embedding
  similarity between question and candidate answer messages.
- `constraint_compliance_results` and `signal_check_results` are never
  touched by retrieval — they're 100% downstream computation, already
  correctly modeled as SQL joins in `risk_assessment.py` / `win_probability.py`.

## Open question before scaffolding
`field_confidence` on `opportunity_features` implies structured extraction
needs its own confidence signal per field — worth deciding now whether
that's rule-based (regex matched vs. inferred) or model-based (extraction
model's own score), since `risk_assessment` already reads it as a
data-quality risk trigger.
