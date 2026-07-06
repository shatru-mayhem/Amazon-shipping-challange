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
| `tender_constraints` | optional: a `constraint_catalog.name` to filter to | FAISS similarity search (`vector_store.VectorStore`) over the document's chunks, queried once per catalog type — a type only gets an LLM call at all if its best-matching chunk clears `CONSTRAINT_RELEVANCE_THRESHOLD = 0.35`; the LLM then confirms/extracts against just that retrieved text, not the whole document |
| `client_highlights` | optional: one of `growth_objective`, `pain_point`, `stated_priority`, `past_complaint` | classify snippets from **both** documents and emails (two separate source systems), batched per source type |
| `email_messages` | optional: a specific `message_id` | semantic match of an unresolved message against later same-thread replies (threshold `EMAIL_SIM_THRESHOLD = 0.65`) |

`tender_constraints` used to (1) ask the model to find arbitrary
constraints in the whole document, then (2) separately embed and
classify each one against the catalog — which let irrelevant text (a
company address, a disclaimer) get force-matched onto an unrelated
constraint type. Retrieving only genuinely relevant chunks per catalog
type *before* calling the LLM fixed that at the source, and cut wall-clock
time roughly in half in testing (3m10s → 1m40s on a 14-chunk real RFQ,
local model).

## Models
- **Embedding** (always local — no cloud embedding models exist): `nomic-embed-text` via `_llm.embed()`, and via `vector_store.VectorStore` for FAISS similarity search.
- **Generation/classification**: `_llm.generate_json()` — local `llama3.2` by default, cloud `gpt-oss:20b-cloud` if `OLLAMA_USE_CLOUD=true`. Measured on real content: local is CPU-bound and scales worse with prompt size (worth it for accuracy — see below); cloud is faster per call but has occasional multi-minute stalls and rate-limit contention under concurrent load. Neither is reliably "fast" — see `_llm.py`'s module docstring for current numbers.
- **A known model-quality issue, worked around defensively**: smaller local models have been observed returning a `"found": false` flag while *still* filling in a real `stated_text`/`value` — self-contradictory output. `tender_constraints` and `opportunity_features` both now trust the text/value field over the boolean flag, and normalize a literal `"null"` string to real `None`, rather than discarding a correct answer because of an unreliable flag.

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
