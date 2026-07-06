"""pricing_recommendations — produce three pricing scenarios (aggressive /
balanced / premium) for an opportunity, anchored on historical won-deal
margins and the cost matrix, within guardrails. Pure read: no writes, no
Gemini. Recommends a scenario but never auto-commits a price (human stays
in the loop).

    from pricing_recommendations import recommend_pricing
    result = recommend_pricing(opportunity_id)
"""

import os
import sys
import json
import statistics

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _db import run_sql, run_sql_one  # noqa: E402


def _percentile(sorted_vals, pct):
    if not sorted_vals:
        return None
    k = (len(sorted_vals) - 1) * pct
    lo = int(k)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def recommend_pricing(opportunity_id: str) -> dict:
    opp = run_sql_one(
        """
        SELECT o.title, o.estimated_value, of.requested_discount_pct, of.volume
        FROM opportunities o
        LEFT JOIN opportunity_features of ON of.opportunity_id = o.opportunity_id
        WHERE o.opportunity_id = %s
        """,
        (opportunity_id,),
    )
    if not opp:
        return {"opportunity_id": opportunity_id, "error": "opportunity not found"}

    won = run_sql(
        "SELECT margin FROM historical_tenders WHERE outcome = 'won' AND margin IS NOT NULL"
    )
    margins = sorted(float(r["margin"]) for r in won)

    cost_ref = run_sql_one(
        "SELECT min(cost_eur) AS min_c, avg(cost_eur) AS avg_c, max(cost_eur) AS max_c FROM cost_matrix"
    ) or {}

    # Margin anchors from what has actually won historically. Fall back to a
    # sane default band if there's no history yet.
    if margins:
        aggressive_m = _percentile(margins, 0.25)
        balanced_m = statistics.median(margins)
        premium_m = _percentile(margins, 0.75)
    else:
        aggressive_m, balanced_m, premium_m = 0.08, 0.15, 0.22

    est_value = float(opp["estimated_value"]) if opp.get("estimated_value") is not None else None

    def scenario(name, margin, intent):
        price = round(est_value * (1 + margin), 2) if est_value is not None else None
        return {
            "name": name,
            "target_margin_pct": round(margin * 100, 1),
            "implied_price_eur": price,
            "intent": intent,
        }

    scenarios = [
        scenario("aggressive", aggressive_m, "Win-focused: lowest defensible margin to beat incumbents."),
        scenario("balanced", balanced_m, "Recommended: median winning margin, best win/margin trade-off."),
        scenario("premium", premium_m, "Margin-focused: for low price sensitivity or unique capability."),
    ]

    requested_discount = opp.get("requested_discount_pct")
    guardrails = []
    if requested_discount is not None and float(requested_discount) > 0:
        guardrails.append(
            f"Client requested a {float(requested_discount):.0f}% discount — the aggressive "
            f"scenario already prices low; deeper discounting erodes margin below history."
        )

    return {
        "opportunity_id": opportunity_id,
        "title": opp.get("title"),
        "estimated_value_eur": est_value,
        "historical_margin_samples": len(margins),
        "cost_matrix_reference_eur": {
            "min": float(cost_ref["min_c"]) if cost_ref.get("min_c") is not None else None,
            "avg": round(float(cost_ref["avg_c"]), 2) if cost_ref.get("avg_c") is not None else None,
            "max": float(cost_ref["max_c"]) if cost_ref.get("max_c") is not None else None,
        },
        "recommended_scenario": "balanced",
        "scenarios": scenarios,
        "guardrails": guardrails,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python pricing_recommendations.py <opportunity_id>")
        sys.exit(1)
    print(json.dumps(recommend_pricing(sys.argv[1]), indent=2, default=str))
