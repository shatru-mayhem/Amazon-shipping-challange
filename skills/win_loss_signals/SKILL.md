---
name: win_loss_signals
description: Check each win_loss_signal_catalog entry against an opportunity's computed data and persist a verdict into signal_check_results, so win_probability has something to actually adjust its estimate with.
---

# Win/Loss Signals

## What it does
`win_probability.py` reads `signal_check_results × win_loss_signal_catalog`
to nudge its estimate away from the raw historical base rate — but
`win_loss_signal_catalog` was empty, so it always just returned the base
rate. This is the step that checks each catalog signal against an
opportunity and persists the verdict, the same way `constraint_compliance`
does for `constraint_compliance_results`.

## Flow position
```
constraint_compliance_results (already computed) + win_loss_signal_catalog (reference)
                    └──────────────┬──────────────┘
                        win_loss_signals
                                   ↓
                        signal_check_results
                                   ↓
              win_probability (estimate) & risk_assessment (commercial risk)
```
Runs inside `persist.py::persist_opportunity`, after
`constraint_compliance` — the one signal currently in the catalog reads
`constraint_compliance_results`, so it depends on that step's rows
already being written for this opportunity.

## The signal, and why it exists
`"Requires delivery to a region outside Amazon's covered network"` —
direction `loss`, strength `0.73` (a log-odds delta, not a percentage).
Derived from real `historical_tenders` outcomes via
`skills/exploration/historical_archetypes.py`'s PCA/clustering pass:
opportunities requiring an uncovered region win 35.3% of the time vs.
61.8% otherwise, and the dominant loss reason for that segment is
specifically `"Geographic gap"` (47/74 losses) rather than generic
competitive loss (`"Lost to competitor"` was only 5/74) — evidence this
is a real Amazon-side capability gap, not noise or a proxy for something
else. See `supabase/migrate_historical_data.sql` and the
`grant_app_ingestion_win_loss_signals` migration for how the number was
seeded.

Checked by reading the opportunity's already-computed `"Delivery region"`
row in `constraint_compliance_results` (`unsatisfied` → `present`,
`satisfied` → `absent_should_check`, anything else/missing →
`unknown_missing_data`) — not by re-deriving "international" from
`opportunity_features.geography` directly, since the compliance verdict
is already the precise, capability-profile-aware answer to that
question.

## Usage
```python
from win_loss_signals import check_signals, persist_signals
computed = check_signals("<opportunity_id>")   # read-only, no writes
result = persist_signals("<opportunity_id>")    # writes, idempotent
```
```bash
python skills/win_loss_signals/win_loss_signals.py <opportunity_id>
```

## Output
`persist_signals` returns `{"rows_written": <int>}` after a
delete-then-insert of `signal_check_results` rows for the opportunity.
`check_signals` returns the same verdicts without writing.

## Adding more signals
1. Validate the pattern on real data via
   `skills/exploration/historical_archetypes.py` first.
2. Add a row to `win_loss_signal_catalog` with a computed `strength`
   (log-odds delta — see the docstring in `win_loss_signals.py` for the
   formula).
3. Add a `_check_<signal>(opportunity_id) -> str` function and register
   it in `_SIGNAL_CHECKERS` here.
