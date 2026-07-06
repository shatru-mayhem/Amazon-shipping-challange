"""executive_summary — synthesize the whole analysis for an opportunity
into one decision-ready summary. This is the convergence point of the flow:
it composes opportunity_score, win_probability, risk_assessment,
commercial_strategy, pricing_recommendations and follow_up_actions. Pure
read: no writes, no Gemini.

    from executive_summary import build_executive_summary
    result = build_executive_summary(opportunity_id)
"""

import os
import sys
import json

_SKILLS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _feat in ("opportunity_score", "win_probability", "risk_assessment",
              "commercial_strategy", "pricing_recommendations", "follow_up_actions"):
    sys.path.insert(0, os.path.join(_SKILLS_DIR, _feat))
sys.path.insert(0, _SKILLS_DIR)

from _db import run_sql_one  # noqa: E402
from opportunity_score import score_opportunity  # noqa: E402
from win_probability import compute_win_probability  # noqa: E402
from risk_assessment import assess_risk  # noqa: E402
from commercial_strategy import build_commercial_strategy  # noqa: E402
from pricing_recommendations import recommend_pricing  # noqa: E402
from follow_up_actions import get_follow_up_actions  # noqa: E402


def build_executive_summary(opportunity_id: str) -> dict:
    opp = run_sql_one(
        """
        SELECT o.title, o.status, o.estimated_value, c.name AS customer_name, c.industry
        FROM opportunities o
        JOIN customers c ON c.customer_id = o.customer_id
        WHERE o.opportunity_id = %s
        """,
        (opportunity_id,),
    ) or {}

    score = score_opportunity(opportunity_id)
    wp = compute_win_probability(opportunity_id)
    risk = assess_risk(opportunity_id)
    strategy = build_commercial_strategy(opportunity_id)
    pricing = recommend_pricing(opportunity_id)
    follow_ups = get_follow_up_actions(opportunity_id)

    recommended = next(
        (s for s in pricing.get("scenarios", []) if s["name"] == pricing.get("recommended_scenario")),
        None,
    )
    top_risks = [r["title"] for r in risk.get("risks", [])[:3]]
    has_hard_blocker = risk.get("has_hard_blocker", False)
    hard_blockers = risk.get("hard_blockers", [])

    headline = (
        f"{opp.get('customer_name', 'Opportunity')} — {score['band'].upper()} "
        f"({score['score']}/100). {round(wp['win_probability']*100)}% win probability, "
        f"{risk['overall_risk']} risk. "
    )
    if recommended:
        headline += f"Recommend {recommended['name']} pricing (~{recommended['target_margin_pct']}% margin)."
    if has_hard_blocker:
        # Prepend, don't bury — a hard blocker changes the read of everything
        # else in the headline (score/win probability/pricing), so it needs
        # to be the first thing anyone sees, not folded into "risks".
        blocker_names = ", ".join(r["title"] for r in hard_blockers)
        headline = f"⚠ HARD BLOCKER — {blocker_names}. " + headline

    summary = {
        "opportunity_id": opportunity_id,
        "customer": opp.get("customer_name"),
        "title": opp.get("title"),
        "status": opp.get("status"),
        "estimated_value_eur": float(opp["estimated_value"]) if opp.get("estimated_value") is not None else None,
        "headline": headline,
        "opportunity_score": {"score": score["score"], "band": score["band"]},
        "win_probability": wp["win_probability"],
        "win_probability_rationale": wp["rationale"],
        "overall_risk": risk["overall_risk"],
        "top_risks": top_risks,
        "has_hard_blocker": has_hard_blocker,
        "hard_blockers": hard_blockers,
        "positioning": strategy.get("positioning_statement"),
        "recommended_pricing": recommended,
        "open_follow_ups": follow_ups["open_action_count"],
        "decision_prompt": _decision_prompt(score, risk, follow_ups),
    }
    return summary


def _decision_prompt(score: dict, risk: dict, follow_ups: dict) -> str:
    if risk.get("has_hard_blocker"):
        # Overrides every other read of score/risk below — a hard blocker
        # means the deal cannot proceed as scoped, independent of how
        # otherwise attractive it looks.
        blocker_names = ", ".join(r["title"] for r in risk.get("hard_blockers", []))
        return (
            f"Do not proceed as scoped — hard capability blocker ({blocker_names}) must be resolved "
            f"or the deal rescoped before this can be committed to."
        )
    if score["band"] == "hot" and risk["overall_risk"] != "high":
        base = "Recommend pursuing — strong score with manageable risk."
    elif score["band"] == "cold":
        base = "Consider deprioritising — low score; qualify harder before investing."
    else:
        base = "Pursue with conditions — address key risks before committing resources."
    if follow_ups["open_action_count"]:
        base += f" {follow_ups['open_action_count']} open item(s) need closing first."
    return base


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python executive_summary.py <opportunity_id>")
        sys.exit(1)
    print(json.dumps(build_executive_summary(sys.argv[1]), indent=2, default=str))
