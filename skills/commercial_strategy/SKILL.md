---
name: commercial_strategy
description: Recommend positioning and a negotiation approach for an opportunity from client highlights, win/loss signals, satisfied-constraint proof points and competitive context.
---

# Commercial Strategy

## What it does
Turns what we know about the client and our competitive standing into a
concrete positioning statement, the strengths to lead with, the objections to
pre-empt, and a negotiation approach.

## Flow position
```
client_highlights + signal_check_results + constraint_compliance_results + opportunity_features
                          └───────────────────┬───────────────────┘
                               commercial_strategy
                        (umbrella over pricing + opportunity_score)
                                              ↓
                            client_proposal & executive_summary
```

## Data source (via nl_query_gemini.run_sql — no Gemini)
- `client_highlights` (pains, priorities, growth objectives)
- `signal_check_results` × `win_loss_signal_catalog` (present win/loss factors)
- `constraint_compliance_results` (satisfied constraints → proof points)
- `opportunity_features` (incumbent_provider, requested_discount_pct)

## Usage
```python
from commercial_strategy import build_commercial_strategy
result = build_commercial_strategy("<opportunity_id>")
```
```bash
python skills/commercial_strategy/commercial_strategy.py <opportunity_id>
```

## Output
`positioning_statement`, `lead_with_strengths`, `proof_points`,
`address_client_pains`, `align_to_priorities`, `objections_to_preempt`,
`negotiation_approach`.
