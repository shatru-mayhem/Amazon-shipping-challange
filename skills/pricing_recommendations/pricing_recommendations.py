"""pricing_recommendations — produce three pricing scenarios (aggressive /
balanced / premium) for an opportunity, anchored on what the delivery
actually costs Amazon (cost_matrix × region_multipliers, for this
opportunity's stated volume and geography) and priced to hit the
financial guardrails' margin bands — not on historical deal prices.
Pure read: no writes, no Gemini. Recommends a scenario but never
auto-commits a price (human stays in the loop).

    from pricing_recommendations import recommend_pricing
    result = recommend_pricing(opportunity_id)

Mechanism:
  1. Look up this opportunity's daily volume -> matching cost_matrix
     daily_volume_band -> per-mile-type EUR cost (first/middle/last mile
     + fixed), averaged across weight bands since no per-opportunity
     package-weight is captured yet (see tender_constraints — "Maximum
     package weight" is Amazon's capability ceiling, not the client's
     actual average weight, and opportunity_features has no weight
     field at all) — never guess a specific weight band.
  2. Look up this opportunity's stated geography -> region_multipliers
     (only regions Amazon actually prices are in that table; a stated
     region absent from it has no cost data, same gap risk_assessment's
     is_hard_blocker already flags for capability — surfaced here too,
     not silently defaulted to a multiplier of 1.0).
  3. total_cost_per_package = sum(avg mile-type cost) x max(matched
     region multiplier) — the highest (most expensive) multiplier among
     the opportunity's covered regions, since pricing for the easiest
     region only would underprice the hardest one.
  4. Three scenarios = that cost priced at three margins taken directly
     from pricing_guardrails: aggressive = the floor
     (min_contribution_margin_pct), balanced = target
     (target_contribution_margin_pct), premium = as far above target as
     target is above the floor (symmetric spread, not an invented
     number). Contribution margin % = (price - cost) / price, so
     price = cost / (1 - margin/100).
  5. discount_pct per scenario = % off the premium scenario's price (the
     "list price" / undiscounted rate) — which is also what ties every
     discount level to a guardrail meaning: 0% (premium) needs no
     approval and carries the most margin; the balanced discount is the
     default opening; the aggressive discount is the deepest a rep can
     go without crossing into requires_vp_approval/auto_no_go territory.
"""

import os
import sys
import json
import re
import statistics

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _db import run_sql, run_sql_one  # noqa: E402

# region_multipliers only has entries for regions Amazon actually prices
# (Spanish Peninsula, Balearic Islands) — a geography term is matched by
# keyword, not exact string, since opportunity_features.geography holds
# free-text-derived values like "Spain"/"France", not the multiplier
# table's formal region names.
_REGION_KEYWORDS = {
    "Balearic Islands": ("balearic",),
    "Spanish Peninsula": ("spain", "peninsula"),
}

_BAND_RE = re.compile(r"^(\d+)\s*-\s*(\d+)$|^(\d+)\+$")


def _parse_volume_band(band: str):
    """'0-200' -> (0, 200); '4000+' -> (4000, None) (open-ended)."""
    m = _BAND_RE.match(band.strip())
    if not m:
        return None
    if m.group(3) is not None:
        return float(m.group(3)), None
    return float(m.group(1)), float(m.group(2))


def _match_volume_band(volume: float, bands: list) -> str:
    parsed = [(b, _parse_volume_band(b)) for b in bands]
    parsed = [(b, p) for b, p in parsed if p is not None]
    for band, (low, high) in parsed:
        if volume >= low and (high is None or volume <= high):
            return band
    # Volume below the lowest band's floor (e.g. 0) or an unparseable set —
    # fall back to the lowest band rather than refusing to price at all.
    parsed.sort(key=lambda bp: bp[1][0])
    return parsed[0][0] if parsed else None


def _region_multiplier(geography: list, multiplier_rows: list):
    """Returns (multiplier, matched_region_names, unmatched_geography_terms).
    multiplier is None if nothing in `geography` matches a priced region —
    that's a real gap, not defaulted to 1.0, since pricing an unpriced
    region at Spanish-Peninsula cost would understate it."""
    if not geography:
        return None, [], []
    matched, unmatched = [], []
    for g in geography:
        g_lower = g.lower()
        hit = next(
            (row for row in multiplier_rows
             if any(kw in g_lower for kw in _REGION_KEYWORDS.get(row["region_name"], ()))),
            None,
        )
        if hit:
            matched.append(hit)
        else:
            unmatched.append(g)
    if not matched:
        return None, [], unmatched
    best = max(matched, key=lambda r: float(r["cost_multiplier"]))
    return float(best["cost_multiplier"]), [r["region_name"] for r in matched], unmatched


def _cost_per_package_eur(daily_volume_band: str) -> dict:
    """Real Amazon cost for one package at this volume band: sum of
    first/middle/last-mile + fixed costs, each averaged across weight
    bands (blended, since the opportunity's actual package-weight mix
    isn't captured anywhere upstream — averaging is honest about that
    gap instead of picking one weight band and pretending it's known)."""
    rows = run_sql(
        """
        SELECT mile_type, avg(cost_eur) AS avg_cost_eur, count(*) AS weight_band_samples
        FROM cost_matrix
        WHERE daily_volume_band = %s
        GROUP BY mile_type
        """,
        (daily_volume_band,),
    )
    by_mile_type = {r["mile_type"]: round(float(r["avg_cost_eur"]), 4) for r in rows}
    return {
        "by_mile_type_eur": by_mile_type,
        "total_eur": round(sum(by_mile_type.values()), 4),
        "weight_bands_averaged": rows[0]["weight_band_samples"] if rows else 0,
    }


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
        SELECT o.title, o.estimated_value, of.requested_discount_pct, of.volume,
               of.geography, of.contract_length_months
        FROM opportunities o
        LEFT JOIN opportunity_features of ON of.opportunity_id = o.opportunity_id
        WHERE o.opportunity_id = %s
        """,
        (opportunity_id,),
    )
    if not opp:
        return {"opportunity_id": opportunity_id, "error": "opportunity not found"}

    guardrails_row = run_sql_one(
        """SELECT min_contribution_margin_pct, target_contribution_margin_pct,
                  vp_approval_required_below_pct, auto_no_go_below_pct, eur_usd_fx_rate
           FROM pricing_guardrails ORDER BY effective_date DESC LIMIT 1"""
    )
    if not guardrails_row:
        return {"opportunity_id": opportunity_id, "title": opp.get("title"), "error": "no pricing_guardrails configured"}

    volume = float(opp["volume"]) if opp.get("volume") is not None else None
    geography = opp.get("geography") or []

    result = {
        "opportunity_id": opportunity_id,
        "title": opp.get("title"),
        "estimated_value_eur": float(opp["estimated_value"]) if opp.get("estimated_value") is not None else None,
        "volume_packages_per_day": volume,
        "geography": geography,
        "financial_guardrails": {
            "min_contribution_margin_pct": float(guardrails_row["min_contribution_margin_pct"]),
            "target_contribution_margin_pct": float(guardrails_row["target_contribution_margin_pct"]),
            "vp_approval_required_below_pct": float(guardrails_row["vp_approval_required_below_pct"]),
            "auto_no_go_below_pct": float(guardrails_row["auto_no_go_below_pct"]),
        },
    }

    # Can't price without knowing daily volume — never guess a band.
    if volume is None:
        result["error"] = "no volume captured for this opportunity — cannot look up a cost_matrix band"
        result["scenarios"] = []
        return result

    bands = [r["daily_volume_band"] for r in run_sql("SELECT DISTINCT daily_volume_band FROM cost_matrix")]
    matched_band = _match_volume_band(volume, bands)
    cost_ref = _cost_per_package_eur(matched_band)

    multiplier_rows = run_sql("SELECT region_name, cost_multiplier FROM region_multipliers")
    region_multiplier, matched_regions, unpriced_regions = _region_multiplier(geography, multiplier_rows)

    # A stated region with no cost data at all is a real gap — same shape
    # as constraint_compliance's is_hard_blocker, surfaced here for pricing
    # rather than silently defaulting to a 1.0x multiplier.
    if region_multiplier is None:
        result["error"] = (
            f"no region_multiplier data for any stated geography ({', '.join(geography) or 'none stated'}) "
            f"— cannot price without a covered region"
        )
        result["scenarios"] = []
        result["cost_matrix_reference_eur"] = cost_ref
        return result

    total_cost_per_package = round(cost_ref["total_eur"] * region_multiplier, 4)
    daily_cost_eur = round(total_cost_per_package * volume, 2)

    g = guardrails_row
    min_m = float(g["min_contribution_margin_pct"])
    target_m = float(g["target_contribution_margin_pct"])
    premium_m = target_m + (target_m - min_m)  # as far above target as target is above the floor

    won_margins = sorted(
        float(r["margin"]) for r in run_sql(
            "SELECT margin FROM historical_tenders WHERE outcome = 'won' AND margin IS NOT NULL"
        )
    )

    def price_at_margin(margin_pct: float) -> float:
        return round(total_cost_per_package / (1 - margin_pct / 100), 4)

    premium_price = price_at_margin(premium_m)  # the "list price" every discount is measured against

    def scenario(name, margin_pct, rationale, tradeoffs, negotiation_strategy):
        price = price_at_margin(margin_pct)
        discount_pct = round((premium_price - price) / premium_price * 100, 1) if premium_price else 0.0
        daily_revenue = round(price * volume, 2)
        contract_value = (
            round(daily_revenue * 30.44 * float(opp["contract_length_months"]), 2)
            if opp.get("contract_length_months") else None
        )
        return {
            "name": name,
            "target_margin_pct": round(margin_pct, 1),
            "price_per_package_eur": price,
            "discount_pct_vs_list": discount_pct,
            "daily_revenue_eur": daily_revenue,
            "contract_value_eur": contract_value,
            "guardrail_result": _guardrail_result(margin_pct, g),
            "rationale": rationale,
            "tradeoffs": tradeoffs,
            "negotiation_strategy": negotiation_strategy,
        }

    scenarios = [
        scenario(
            "aggressive", min_m,
            f"Priced at the guardrail floor ({min_m:.0f}% contribution margin) — the deepest discount "
            f"off list ({premium_price} EUR/package) a rep can offer without needing VP approval.",
            "Thinnest margin of the three; zero room to absorb scope creep, currency movement, or an "
            "underestimated volume/weight mix.",
            "Open here only if the client has a credible competing bid — hold the line at this floor, "
            "any further discount crosses into requires_vp_approval.",
        ),
        scenario(
            "balanced", target_m,
            f"Priced at the guardrail target ({target_m:.0f}% contribution margin) — the standard, "
            f"fully-costed rate for this opportunity's actual volume ({int(volume)}/day) and region.",
            "Neither the cheapest nor the highest-margin option; the rate to defend as \"standard "
            "terms,\" not a first offer to concede from.",
            "Default opening position. Frame as reflecting real cost-to-serve for the stated volume "
            "and geography, not an arbitrary starting point.",
        ),
        scenario(
            "premium", premium_m,
            f"List price — as far above target margin ({target_m:.0f}%) as target sits above the floor "
            f"({min_m:.0f}%), i.e. {premium_m:.0f}% contribution margin.",
            "Higher win-probability cost; only defensible with a genuine differentiator (coverage, "
            "SLA, incumbent's known gaps) on the table.",
            "Anchor here and justify with specific proof points before considering any move toward "
            "balanced — every other scenario is framed as a discount off this rate.",
        ),
    ]

    requested_discount = opp.get("requested_discount_pct")
    guardrail_notes = [
        "Discount levels, tied to guardrail meaning: 0% (premium/list) needs no approval and carries "
        f"the most margin ({premium_m:.0f}%); up to {round((premium_price - price_at_margin(target_m)) / premium_price * 100, 1)}% "
        f"off list (balanced, {target_m:.0f}% margin) is the standard negotiable range; up to "
        f"{round((premium_price - price_at_margin(min_m)) / premium_price * 100, 1)}% off list (aggressive, {min_m:.0f}% margin) is "
        "the deepest a rep can go unilaterally — anything beyond that requires VP approval "
        f"(margin below {float(g['vp_approval_required_below_pct']):.0f}%), and below "
        f"{float(g['auto_no_go_below_pct']):.0f}% margin is an automatic no-go.",
    ]
    if requested_discount is not None and float(requested_discount) > 0:
        implied_price = round(premium_price * (1 - float(requested_discount) / 100), 4)
        implied_margin = round((implied_price - total_cost_per_package) / implied_price * 100, 1) if implied_price else None
        guardrail_notes.append(
            f"Client requested {float(requested_discount):.0f}% off — against this opportunity's real cost "
            f"({total_cost_per_package} EUR/package), that implies ~{implied_margin}% contribution margin "
            f"({_guardrail_result(implied_margin, g) if implied_margin is not None else 'unknown'})."
        )
    if unpriced_regions:
        guardrail_notes.append(
            f"No cost data for: {', '.join(unpriced_regions)} — pricing above covers {', '.join(matched_regions)} "
            f"only; stated regions without cost data are also a capability gap (see risk_assessment)."
        )

    result.update({
        "cost_matrix_reference_eur": cost_ref,
        "region_multiplier_applied": region_multiplier,
        "regions_priced": matched_regions,
        "regions_without_cost_data": unpriced_regions,
        "total_cost_per_package_eur": total_cost_per_package,
        "daily_cost_eur": daily_cost_eur,
        "historical_won_margin_context_pct": {
            "p25": round(won_margins[int(len(won_margins) * 0.25)] * 100, 1) if won_margins else None,
            "p50": round(statistics.median(won_margins) * 100, 1) if won_margins else None,
            "p75": round(won_margins[int(len(won_margins) * 0.75)] * 100, 1) if won_margins else None,
        },
        "recommended_scenario": "balanced",
        "scenarios": scenarios,
        "guardrails": guardrail_notes,
    })
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python pricing_recommendations.py <opportunity_id>")
        sys.exit(1)
    print(json.dumps(recommend_pricing(sys.argv[1]), indent=2, default=str))
