---
name: pricing_recommendations
description: Produce three pricing scenarios (aggressive / balanced / premium) for an opportunity, anchored on historical won-deal margins and the cost matrix, with guardrails. Recommends but never auto-commits a price.
---

# Pricing Recommendations

## What it does
Generates three defensible pricing scenarios and recommends one, anchored on
the margins that have actually won historically — keeping a human in the loop
for the final call (no automated pricing commitment).

## Flow position
```
historical_tenders(margin) + cost_matrix + opportunity_features + opportunities
                              └────────────┬────────────┘
                              pricing_recommendations   ← part of Commercial Strategy
                                           ↓
                        client_proposal & executive_summary
```

## Data source (via nl_query_gemini.run_sql — no Gemini)
- `historical_tenders` (won-deal margins → percentile anchors)
- `cost_matrix` (min / avg / max cost reference)
- `opportunities` (estimated_value)
- `opportunity_features` (requested_discount_pct, volume)

## How it computes
- **aggressive** = 25th percentile of historical won margins.
- **balanced** = median won margin *(recommended)*.
- **premium** = 75th percentile.
- Implied price = `estimated_value × (1 + target_margin)`.
- Guardrail note fires when the client's requested discount pushes below the
  historical winning band.

## Usage
```python
from pricing_recommendations import recommend_pricing
result = recommend_pricing("<opportunity_id>")
```
```bash
python skills/pricing_recommendations/pricing_recommendations.py <opportunity_id>
```

## Output
`scenarios` (3), `recommended_scenario`, `cost_matrix_reference_eur`,
`guardrails`.
