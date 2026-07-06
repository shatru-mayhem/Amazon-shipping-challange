---
name: constraint_compliance
description: Compare each tender_constraints row for an opportunity against Amazon's amazon_capability_profile and persist satisfied/unsatisfied/unclear verdicts into constraint_compliance_results.
---

# Constraint Compliance

## What it does
The step that was missing between "we extracted what the tender asks
for" (`tender_constraints`) and "risk_assessment / commercial_strategy
can read compliance verdicts" (`constraint_compliance_results`). For
every constraint stated in a tender, it looks up Amazon's capability
row for that same constraint type and decides: satisfied, unsatisfied,
or unclear_needs_verification — pure comparison over already-structured
JSON, no LLM call.

## Flow position
```
tender_constraints (this run) + amazon_capability_profile (reference)
                    └──────────────┬──────────────┘
                        constraint_compliance
                                   ↓
                 constraint_compliance_results
                                   ↓
          risk_assessment & commercial_strategy (read verdicts)
```
Runs inside `persist.py::persist_opportunity`, immediately after
`_persist_tender_constraints` — it depends on that step's rows already
being written for this opportunity.

## Verdict logic
- No capability row at all for the constraint type → `unclear_needs_verification`, medium severity.
- `capability_status = 'cannot_do'` → `unsatisfied`, high severity.
- Stated value matches an explicit `not_covered` / `not_supported` / `forbidden` entry in `structured_value` → `unsatisfied`, high severity, regardless of capability_status.
- Stated numeric value exceeds a hard limit (`max_weight_kg`, `max_attempts`) in `structured_value` → `unsatisfied`, high severity.
- `capability_status = 'can_do'` and neither of the above → `satisfied`.
- `capability_status = 'can_do_with_conditions'` and the stated value matches a known-covered bucket (or the capability's `structured_value` has no exclusion/inclusion/limit shape to check at all, e.g. a flat fee schedule) → `satisfied`, with `conditions_text` carried into `gap_description` as a pricing/process note, not a risk (severity `low`/`none`).
- Anything else (can't parse a clean numeric/list comparison) → `unclear_needs_verification`, medium severity, rather than guessing.

## Data source (pure SQL — no Gemini, no FAISS)
- `tender_constraints` (this opportunity's stated requirements)
- `constraint_catalog` (constraint name/data_type)
- `amazon_capability_profile` (capability_status, structured_value, conditions_text)

## Usage
```python
from constraint_compliance import check_compliance, persist_compliance
computed = check_compliance("<opportunity_id>")   # read-only, no writes
result = persist_compliance("<opportunity_id>")   # writes, idempotent
```
```bash
python skills/constraint_compliance/constraint_compliance.py <opportunity_id>
```

## Output
`persist_compliance` returns `{"rows_written": <int>}` after a
delete-then-insert of `constraint_compliance_results` rows for the
opportunity (idempotent — safe to re-run). `check_compliance` returns
the same verdicts without writing, each with `tender_constraint_id`,
`capability_id`, `result`, `severity`, `gap_description`,
`constraint_name`.
