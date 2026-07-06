---
name: executive_summary
description: Synthesize opportunity score, win probability, risk, commercial strategy, pricing and open follow-ups into one decision-ready executive summary.
---

# Executive Summary

## What it does
The convergence point of the flow. Pulls together every other skill into a
single, decision-ready summary with a clear pursue / conditions / deprioritise
prompt.

## Flow position
```
opportunity_score ┐
win_probability   │
risk_assessment   ├──► executive_summary ──► decision
commercial_strategy│
pricing_recommendations│
follow_up_actions ┘
```

## Composition
Composes (does not re-query) all of:
`opportunity_score`, `win_probability`, `risk_assessment`,
`commercial_strategy`, `pricing_recommendations`, `follow_up_actions`,
plus `opportunities`/`customers` context via direct SQL.

## Usage
```python
from executive_summary import build_executive_summary
result = build_executive_summary("<opportunity_id>")
```
```bash
python skills/executive_summary/executive_summary.py <opportunity_id>
```

## Output
`headline`, `opportunity_score`, `win_probability` + rationale,
`overall_risk` + `top_risks`, `positioning`, `recommended_pricing`,
`open_follow_ups`, and a `decision_prompt`.
