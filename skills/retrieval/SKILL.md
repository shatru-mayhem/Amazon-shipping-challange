---
name: retrieval
description: The retrieval engine. Downstream skills ask for one (table, field) they need; retrieval finds it in raw tender documents or emails and reports back — found or not_found, always, synchronously.
---

# Retrieval

## What it does
The single point of contact between every other skill and raw source
text. A downstream process asks for exactly what it needs; retrieval
looks, and returns a complete answer before the caller proceeds. There is
no third outcome — "not found" is a real, valid response, not a failure
the caller has to guess about or retry until.

```
{"status": "found",     "value": ..., "confidence": ..., "source": {...}}
{"status": "not_found", "reason": "<specifically why>"}
```

## Flow position
Upstream of everything else — this is what fills the 4 tables the other
8 skills read (see `RETRIEVAL_REQUIREMENTS.md` at the repo root for the
full skill → field → origin matrix):

```
document_chunks (challenge_doc)  ──┐
email_messages (email/CRM)       ──┼──►  retrieve(opportunity_id, table, field)
constraint_catalog (reference)   ──┘             │
                                                  ▼
                          opportunity_features / tender_constraints /
                          client_highlights / email_messages (resolved)
                                                  │
                                                  ▼
                    pricing_recommendations, commercial_strategy,
                    risk_assessment, win_probability, ... (unchanged)
```

## Why only 4 tables
Everything else a downstream skill reads (`constraint_compliance_results`,
`signal_check_results`, `historical_tenders`, `cost_matrix`,
`amazon_capability_profile`) is either internal Amazon reference data or
pure SQL computation over these 4 — no retrieval involved, see
`RETRIEVAL_REQUIREMENTS.md` Step 0.

## Tables served

| table | field | method |
|---|---|---|
| `opportunity_features` | one of `volume`, `lanes`, `geography`, `industry_vertical`, `contract_length_months`, `required_sla_hours`, `incumbent_provider`, `requested_discount_pct` | structured extraction (`generate_json`) over `challenge_doc` chunks |
| `tender_constraints` | optional: a `constraint_catalog.name` to filter to | extract constraint statements, then classify each against `constraint_catalog` by embedding cosine similarity (threshold `CONSTRAINT_SIM_THRESHOLD = 0.60`) |
| `client_highlights` | optional: one of `growth_objective`, `pain_point`, `stated_priority`, `past_complaint` | classify snippets from **both** documents and emails (two separate source systems) |
| `email_messages` | optional: a specific `message_id` | semantic match of an unresolved message against later same-thread replies (threshold `EMAIL_SIM_THRESHOLD = 0.65`) |

## Models
- **Embedding** (always local — no cloud embedding models exist): `nomic-embed-text` via `_llm.embed()`.
- **Generation/classification**: `_llm.generate_json()` — cloud `gpt-oss:20b-cloud` when `OLLAMA_API_KEY` is set, local `llama3.2` otherwise.

## Usage
```python
from retrieval import retrieve
result = retrieve("<opportunity_id>", "opportunity_features", "volume")
result = retrieve("<opportunity_id>", "tender_constraints")
result = retrieve("<opportunity_id>", "client_highlights", "pain_point")
result = retrieve("<opportunity_id>", "email_messages")
```
```bash
python skills/retrieval/retrieval.py <opportunity_id> <table> [field]
```

## Contract, explicitly
- `retrieve()` never raises for missing data — a `not_found` `reason` is
  always specific (no source docs ingested vs. field not stated vs. no
  match above threshold vs. already resolved), so a caller can write a
  precise `run_flags` row (`missing_required_input` /
  `low_confidence_field`) instead of guessing.
- `retrieve()` only raises for a caller bug — asking for a `table` it has
  no handler for at all.
- Nothing here writes to the database. Persisting a `found` value into
  `opportunity_features`/`tender_constraints`/`client_highlights` (and
  flipping `email_messages.resolved`) is the caller's decision, not
  retrieval's — retrieval answers a question, it doesn't commit an
  extraction.
