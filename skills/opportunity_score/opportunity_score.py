"""opportunity_score — a single 0–100 prioritisation score for an
opportunity, combining win probability, assessed risk and deal value.
Composes the win_probability and risk_assessment skills; the raw data all
comes from the DB via those. No writes, no Gemini.

    from opportunity_score import score_opportunity
    result = score_opportunity(opportunity_id)
"""

import os
import sys
import json

_SKILLS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _SKILLS_DIR)
sys.path.insert(0, os.path.join(_SKILLS_DIR, "win_probability"))
sys.path.insert(0, os.path.join(_SKILLS_DIR, "risk_assessment"))

from _db import run_sql_one  # noqa: E402
from win_probability import compute_win_probability  # noqa: E402
from risk_assessment import assess_risk  # noqa: E402

RISK_PENALTY = {"high": 15, "medium": 7, "low": 2}


def score_opportunity(opportunity_id: str) -> dict:
    wp = compute_win_probability(opportunity_id)
    risk = assess_risk(opportunity_id)

    opp = run_sql_one(
        "SELECT title, estimated_value FROM opportunities WHERE opportunity_id = %s",
        (opportunity_id,),
    ) or {}
    est_value = float(opp["estimated_value"]) if opp.get("estimated_value") is not None else None

    # Start from win probability, subtract accumulated risk, add a small
    # value tilt so bigger winnable deals rank above tiny ones.
    base = wp["win_probability"] * 100
    penalty = sum(RISK_PENALTY.get(sev, 0) * n for sev, n in risk["severity_counts"].items())

    value_bonus = 0
    value_tier = "unknown"
    if est_value is not None:
        if est_value >= 1_000_000:
            value_bonus, value_tier = 10, "large"
        elif est_value >= 250_000:
            value_bonus, value_tier = 5, "medium"
        else:
            value_bonus, value_tier = 2, "small"

    score = max(0, min(100, round(base - penalty + value_bonus)))
    band = "hot" if score >= 70 else "warm" if score >= 45 else "cold"

    return {
        "opportunity_id": opportunity_id,
        "title": opp.get("title"),
        "score": score,
        "band": band,
        "components": {
            "win_probability": wp["win_probability"],
            "risk_penalty": penalty,
            "overall_risk": risk["overall_risk"],
            "value_tier": value_tier,
            "value_bonus": value_bonus,
        },
        "rationale": (
            f"{band.upper()} ({score}/100): {round(wp['win_probability']*100)}% win probability, "
            f"{risk['risk_count']} risk(s) [{risk['overall_risk']}], {value_tier} deal value."
        ),
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python opportunity_score.py <opportunity_id>")
        sys.exit(1)
    print(json.dumps(score_opportunity(sys.argv[1]), indent=2, default=str))
