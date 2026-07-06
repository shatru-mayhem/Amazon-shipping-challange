"""pricing_recommendations — produce three pricing scenarios (aggressive /
balanced / premium) for an opportunity, anchored on historical won-deal
margins and the cost matrix, checked against the actual financial
guardrails (pricing_guardrails). Pure read: no writes, no Gemini.
Recommends a scenario but never auto-commits a price (human stays in
the loop).

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


def _guardrail_result(margin_pct: float, g: dict) -> str:
    if margin_pct < float(g["auto_no_go_below_pct"]):
        return "auto_no_go"
    if margin_pct < float(g["vp_approval_required_below_pct"]):
        return "requires_vp_approval"
    if margin_pct < float(g["target_contribution_margin_pct"]):
        return "above_min_below_target"
    return "within_target"


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

    guardrails_row = run_sql_one(
        """SELECT min_contribution_margin_pct, target_contribution_margin_pct,
                  vp_approval_required_below_pct, auto_no_go_below_pct, eur_usd_fx_rate
           FROM pricing_guardrails ORDER BY effective_date DESC LIMIT 1"""
    )
    guardrail_floor_pct = float(guardrails_row["min_contribution_margin_pct"]) if guardrails_row else None

    # Margin anchors from what has actually won historically. Fall back to a
    # sane default band if there's no history yet.
    if margins:
        aggressive_m = _percentile(margins, 0.25)
        balanced_m = statistics.median(margins)
        premium_m = _percentile(margins, 0.75)
    else:
        aggressive_m, balanced_m, premium_m = 0.08, 0.15, 0.22

    est_value = float(opp["estimated_value"]) if opp.get("estimated_value") is not None else None

    def scenario(name, raw_margin, rationale, tradeoffs, negotiation_strategy):
        # "All scenarios must comply with the financial guardrails" — floor
        # every scenario's margin at the guardrail minimum rather than
        # silently recommending something that would need VP sign-off or
        # trigger an auto-no-go. floor_applied tells the caller when a
        # scenario's historically-derived margin needed raising to comply.
        margin = raw_margin
        floor_applied = False
        if guardrail_floor_pct is not None and raw_margin * 100 < guardrail_floor_pct:
            margin = guardrail_floor_pct / 100
            floor_applied = True

        margin_pct = round(margin * 100, 1)
        price = round(est_value * (1 + margin), 2) if est_value is not None else None
        result = {
            "name": name,
            "target_margin_pct": margin_pct,
            "implied_price_eur": price,
            "rationale": rationale,
            "tradeoffs": tradeoffs,
            "negotiation_strategy": negotiation_strategy,
        }
        if guardrails_row:
            result["guardrail_result"] = _guardrail_result(margin_pct, guardrails_row)
            result["floor_applied"] = floor_applied
            if floor_applied:
                result["floor_note"] = (
                    f"Historical margin ({round(raw_margin * 100, 1)}%) was below the guardrail "
                    f"minimum ({guardrail_floor_pct}%) — raised to comply."
                )
        return result

    scenarios = [
        scenario(
            "aggressive", aggressive_m,
            "Lowest defensible margin, anchored on the 25th percentile of historically won deals — positions to beat an incumbent on price.",
            "Thinnest margin of the three; leaves little room to absorb scope creep or currency movement.",
            "Open here only if the client has a credible competing bid — hold the line at the guardrail floor, don't go lower.",
        ),
        scenario(
            "balanced", balanced_m,
            "Median margin of historically won deals — the best empirical trade-off between win rate and margin.",
            "Neither the cheapest nor the highest-margin option; a generalist choice, not tailored to this specific deal's risk profile.",
            "Default opening position. Frame as reflecting standard terms for comparable volume/geography, not open to negotiation.",
        ),
        scenario(
            "premium", premium_m,
            "75th percentile of historically won deals — justified when Amazon Shipping holds a unique capability edge or the client has low price sensitivity.",
            "Higher win-probability cost; only defensible if a genuine differentiator (coverage, SLA, integration) is on the table.",
            "Anchor high and justify with specific proof points (capability match, incumbent's known gaps) before considering any move toward balanced.",
        ),
    ]

    requested_discount = opp.get("requested_discount_pct")
    guardrail_notes = []
    if requested_discount is not None and float(requested_discount) > 0:
        guardrail_notes.append(
            f"Client requested a {float(requested_discount):.0f}% discount — the aggressive "
            f"scenario already prices low; deeper discounting erodes margin below history."
        )
    for s in scenarios:
        if s.get("floor_applied"):
            guardrail_notes.append(f"{s['name'].capitalize()}: {s['floor_note']}")

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
        "financial_guardrails": (
            {
                "min_contribution_margin_pct": float(guardrails_row["min_contribution_margin_pct"]),
                "target_contribution_margin_pct": float(guardrails_row["target_contribution_margin_pct"]),
                "vp_approval_required_below_pct": float(guardrails_row["vp_approval_required_below_pct"]),
                "auto_no_go_below_pct": float(guardrails_row["auto_no_go_below_pct"]),
            }
            if guardrails_row else None
        ),
        "recommended_scenario": "balanced",
        "scenarios": scenarios,
        "guardrails": guardrail_notes,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python pricing_recommendations.py <opportunity_id>")
        sys.exit(1)
    print(json.dumps(recommend_pricing(sys.argv[1]), indent=2, default=str))
