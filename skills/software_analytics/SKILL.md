---
name: software_analytics
description: Aggregate real token usage and latency telemetry across every LLM call the pipeline has made (embed + generate_json), broken down by skill and model.
---

# Software Analytics

## What it does
Reports on the pipeline's own LLM usage — not a per-opportunity output like
the other 8 skills, but a system-wide view of tokenomics and latency across
every call `skills/_llm.py` has made.

## Flow position
```
skills/_llm.py's embed()/generate_json()
        │  (every call logged, best-effort)
        ▼
observability.llm_call_log
        │
software_analytics
```

## Data source (via nl_query_readonly — no Gemini)
- `observability.llm_call_log` — one row per LLM call: model, call_type
  (embed/generate_json), is_cloud, prompt/completion/total tokens (real,
  from Ollama's `/api/generate` response — the legacy `/api/embeddings`
  endpoint doesn't return token counts, only embed's wall-clock latency is
  captured), total/load/eval duration, success, error_message, created_at.

## Usage
```python
from software_analytics import get_software_analytics
result = get_software_analytics()
```
```bash
python skills/software_analytics/software_analytics.py
```

## Output
`total_calls`, `success_rate`, token totals, `avg_latency_ms` /
`p50_latency_ms` / `p95_latency_ms`, `cloud_calls` / `local_calls`,
`by_skill` (call count/tokens/latency per retrieval.py function),
`by_model` (per model/call_type/is_cloud), `recent_calls`, and
`latency_timeline` (chronological per-call series for a timeline chart).
No $ cost figure — Ollama's cloud API isn't billed at a published
per-token rate, so token counts are shown instead of an invented estimate.
