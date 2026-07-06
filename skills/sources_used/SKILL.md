---
name: sources_used
description: The evidence trail behind an opportunity's analysis — challenge documents and emails actually ingested, plus the internal reference datasets every other skill draws on.
---

# Sources Used

## What it does
Answers "what evidence did the AI system actually use?" — one of the
required outputs alongside executive_summary, opportunity_score,
risk_assessment, pricing_recommendations, commercial_strategy,
follow_up_actions, client_proposal, and win_probability. Reports what
exists; doesn't judge whether it's enough (that's what `follow_up_actions`
already surfaces via unresolved emails / unclear constraints / open
pipeline flags).

## Two kinds of evidence
- **Opportunity-specific**: `documents` actually ingested for this
  opportunity (filename, source_type, when), email thread/message
  counts, how many `tender_constraints` were extracted, and
  `client_highlights` broken down by source (document vs email).
- **Internal reference data**: `historical_tenders`, `cost_matrix`,
  `constraint_catalog`, `amazon_capability_profile`, and the current
  `pricing_guardrails` — not opportunity-specific, but every
  recommendation traces back to these (e.g. "why balanced pricing?"
  traces to `historical_tenders`, not to the tender document).

## Usage
```python
from sources_used import list_sources_used
result = list_sources_used("<opportunity_id>")
```
```bash
python skills/sources_used/sources_used.py <opportunity_id>
```

## Output
`challenge_documents` (list), `email_correspondence` (thread/message
counts), `extracted_evidence` (tender_constraints count, highlights by
source), `internal_reference_data` (row counts + which skills use each).
