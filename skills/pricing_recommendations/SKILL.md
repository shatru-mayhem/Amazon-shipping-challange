---
name: pricing_recommendations
description: Produce three pricing scenarios (aggressive / balanced / premium) for an opportunity, priced from Amazon's actual delivery cost (cost_matrix x region_multipliers, for this opportunity's real volume and geography) against the financial guardrails' margin bands.
---

# Pricing Recommendations

## What it does
Generates three defensible, cost-and-guardrail-anchored pricing scenarios and
recommends one — not anchored on historical deal prices, but on what this
specific opportunity's volume and delivery region actually cost Amazon to
serve. Keeps a human in the loop for the final call (no automated pricing
commitment).

## Flow position
```
cost_matrix + region_multipliers + pricing_guardrails + opportunity_features
                              └────────────┬────────────┘
                              pricing_recommendations   ← part of Commercial Strategy
                                           ↓
                        client_proposal & executive_summary
```

## Data source (via nl_query_gemini.run_sql — no Gemini)
- `cost_matrix` (per-mile-type EUR cost, by daily_volume_band; averaged
  across weight_band since no per-opportunity package weight is captured
  anywhere upstream)
- `region_multipliers` (only regions Amazon actually prices — Spanish
  Peninsula, Balearic Islands)
- `pricing_guardrails` (min / target / VP-approval / auto-no-go margin %)
- `opportunity_features` (volume, geography, contract_length_months,
  requested_discount_pct)
- `historical_tenders` (won-deal margins → shown as context only, no
  longer used to set scenario numbers)

## How it computes
1. Match `opportunity_features.volume` to a `cost_matrix.daily_volume_band`,
   sum the averaged first/middle/last-mile + fixed costs -> cost per package.
2. Match `opportunity_features.geography` to `region_multipliers` by keyword
   (e.g. "Spain" -> Spanish Peninsula); a stated region with no multiplier
   row is a real gap, not defaulted to 1.0x — surfaced in
   `regions_without_cost_data`, same shape as `constraint_compliance`'s
   `is_hard_blocker`. Multiple matched regions use the highest (most
   expensive) multiplier, so the price never underserves the harder region.
3. Three scenarios = that real cost priced at three guardrail margins:
   **aggressive** = `min_contribution_margin_pct` (the floor — the deepest
   discount without VP approval), **balanced** = `target_contribution_margin_pct`
   (the standard rate), **premium** = as far above target as target is above
   the floor (the "list price" every discount is measured against).
   Contribution margin % = `(price - cost) / price`.
4. `discount_pct_vs_list` on each scenario is % off the premium price —
   directly tying every discount level to a guardrail meaning (see
   `guardrails` notes in the output for the exact bands).
5. No volume or no priced region -> `error` explaining the gap and an empty
   `scenarios` list, rather than guessing a band or a 1.0x multiplier.

## Usage
```python
from pricing_recommendations import recommend_pricing
result = recommend_pricing("<opportunity_id>")
```
```bash
python skills/pricing_recommendations/pricing_recommendations.py <opportunity_id>
```

## Output
`total_cost_per_package_eur`, `region_multiplier_applied`, `regions_priced`,
`regions_without_cost_data`, `scenarios` (3, each with `price_per_package_eur`,
`discount_pct_vs_list`, `daily_revenue_eur`, `contract_value_eur`,
`rationale`/`tradeoffs`/`negotiation_strategy`/`guardrail_result`),
`recommended_scenario`, `financial_guardrails`, `guardrails` (notes, incl.
what each discount level means), `historical_won_margin_context_pct`
(informational only).
