"""win_probability — estimate the probability of winning an opportunity.

Reads the win/loss signals that were checked for this opportunity
(signal_check_results x win_loss_signal_catalog) plus the historical
tender base rate, and turns them into a single probability with a
per-signal rationale. Pure read: no writes, no Gemini.

    from win_probability import compute_win_probability
    result = compute_win_probability(opportunity_id)
"""

import os
import sys
import math
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _db import run_sql, run_sql_one  # noqa: E402


def _logistic(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def compute_win_probability(opportunity_id: str) -> dict:
    signals = run_sql(
        """
        SELECT c.factor_name, c.direction, c.strength, r.status
        FROM signal_check_results r
        JOIN win_loss_signal_catalog c ON c.signal_id = r.signal_id
        WHERE r.opportunity_id = %s
        """,
        (opportunity_id,),
    )

    base = run_sql_one(
        """
        SELECT
            count(*) FILTER (WHERE outcome = 'won')  AS won,
            count(*) FILTER (WHERE outcome = 'lost') AS lost
        FROM historical_tenders
        """
    ) or {"won": 0, "lost": 0}
    won, lost = base.get("won") or 0, base.get("lost") or 0
    base_rate = (won / (won + lost)) if (won + lost) else 0.5

    # Only 'present' signals move the estimate; win pushes up, loss pushes down.
    net, contributing, missing = 0.0, [], []
    for s in signals:
        strength = float(s["strength"])
        if s["status"] == "present":
            delta = strength if s["direction"] == "win" else -strength
            net += delta
            contributing.append({"factor": s["factor_name"], "direction": s["direction"],
                                  "strength": strength, "effect": round(delta, 3)})
        elif s["status"] == "unknown_missing_data":
            missing.append(s["factor_name"])

    # Blend a historical prior with the signal evidence. log-odds of the base
    # rate is the starting point; signal net strength nudges it from there.
    prior_logodds = math.log(base_rate / (1 - base_rate)) if 0 < base_rate < 1 else 0.0
    probability = _logistic(prior_logodds + net)

    contributing.sort(key=lambda c: abs(c["effect"]), reverse=True)

    return {
        "opportunity_id": opportunity_id,
        "win_probability": round(probability, 3),
        "base_rate": round(base_rate, 3),
        "net_signal_strength": round(net, 3),
        "signals_present": len(contributing),
        "top_drivers": contributing[:5],
        "missing_data_signals": missing,
        "rationale": _rationale(probability, contributing, missing),
    }


def _rationale(prob: float, contributing: list, missing: list) -> str:
    band = "high" if prob >= 0.66 else "moderate" if prob >= 0.4 else "low"
    parts = [f"{band} win likelihood ({round(prob * 100)}%)."]
    wins = [c["factor"] for c in contributing if c["effect"] > 0]
    losses = [c["factor"] for c in contributing if c["effect"] < 0]
    if wins:
        parts.append("In our favour: " + ", ".join(wins[:3]) + ".")
    if losses:
        parts.append("Working against us: " + ", ".join(losses[:3]) + ".")
    if missing:
        parts.append(f"{len(missing)} signal(s) could not be evaluated (missing data).")
    return " ".join(parts)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python win_probability.py <opportunity_id>")
        sys.exit(1)
    print(json.dumps(compute_win_probability(sys.argv[1]), indent=2, default=str))
