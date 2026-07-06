---
name: risk_assessment
description: Surface operational, commercial, financial and data-quality risks for an opportunity from constraint compliance, win/loss signals and tender features.
---

# Risk Assessment

## What it does
Aggregates the things that could go wrong on an opportunity into a single,
severity-ranked list plus an overall risk level.

## Flow position
```
constraint_compliance_results + signal_check_results + opportunity_features
                                └──────────┬──────────┘
                                    risk_assessment
                                          ↓
                        opportunity_score & executive_summary
```

## Data source (via nl_query_gemini.run_sql — no Gemini)
- `constraint_compliance_results` (unsatisfied / unclear constraints)
- `signal_check_results` × `win_loss_signal_catalog` (present loss signals)
- `opportunity_features` (requested discount, field_confidence)

## Risk categories produced
- **operational** — a constraint Amazon cannot satisfy.
- **verification** — a constraint whose result is unclear.
- **commercial** — a historical loss signal is present.
- **financial** — aggressive requested discount (≥ 15%).
- **data_quality** — extracted fields with confidence < 0.5.

## Usage
```python
from risk_assessment import assess_risk
result = assess_risk("<opportunity_id>")
```
```bash
python skills/risk_assessment/risk_assessment.py <opportunity_id>
```

## Output
`overall_risk`, `risk_count`, `severity_counts`, and a sorted `risks` list
(each with category, severity, title, detail).
