---
name: win_probability
description: Estimate the probability of winning an opportunity from checked win/loss signals and the historical tender base rate, with a per-signal rationale.
---

# Win Probability

## What it does
Turns the win/loss signals recorded for an opportunity into a single win
probability (0–1) plus a human-readable rationale of what is driving it.

## Flow position
```
signal_check_results  +  win_loss_signal_catalog  +  historical_tenders
        └────────────────────────┬─────────────────────────┘
                          win_probability
                                  ↓
                 opportunity_score  &  executive_summary
```

## Data source (via nl_query_gemini.run_sql — no Gemini)
- `signal_check_results` (status per signal for this opportunity)
- `win_loss_signal_catalog` (direction win/loss, strength)
- `historical_tenders` (won/lost counts → base rate)

## How it computes
1. Base rate = historical won / (won + lost).
2. Start from the log-odds of the base rate.
3. Each `present` signal nudges the log-odds: `+strength` for win signals,
   `-strength` for loss signals.
4. Apply the logistic function → probability.
5. `unknown_missing_data` signals are reported separately, never guessed.

## Usage
```python
from win_probability import compute_win_probability
result = compute_win_probability("<opportunity_id>")
# {"win_probability": 0.71, "top_drivers": [...], "rationale": "..."}
```
```bash
python skills/win_probability/win_probability.py <opportunity_id>
```

## Output
`win_probability`, `base_rate`, `net_signal_strength`, `top_drivers`,
`missing_data_signals`, `rationale`.
