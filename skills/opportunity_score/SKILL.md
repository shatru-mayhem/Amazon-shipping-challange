---
name: opportunity_score
description: A single 0–100 prioritisation score (hot/warm/cold) for an opportunity, combining win probability, assessed risk and deal value.
---

# Opportunity Score

## What it does
Rolls win probability, risk and deal value into one comparable score so
opportunities can be prioritised at a glance.

## Flow position
```
win_probability  +  risk_assessment  +  opportunities(estimated_value)
             └───────────────┬───────────────┘
                     opportunity_score   ← part of Commercial Strategy
                             ↓
                      executive_summary
```

## Composition
This skill **composes** two other skills rather than re-querying:
- `win_probability.compute_win_probability`
- `risk_assessment.assess_risk`
- plus `opportunities.estimated_value` (direct SQL) for the value tilt.

## Scoring
```
score = clamp( win_probability×100 − risk_penalty + value_bonus , 0, 100 )
risk_penalty = high×15 + medium×7 + low×2
value_bonus  = large:10 / medium:5 / small:2
band = hot (≥70) / warm (≥45) / cold (<45)
```

## Usage
```python
from opportunity_score import score_opportunity
result = score_opportunity("<opportunity_id>")
```
```bash
python skills/opportunity_score/opportunity_score.py <opportunity_id>
```

## Output
`score`, `band`, `components` (breakdown), `rationale`.
