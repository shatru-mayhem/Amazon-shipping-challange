"""risk_assessment — surface operational, commercial and financial risks
for an opportunity from constraint compliance, win/loss signals and the
extracted tender features. Pure read: no writes, no Gemini.

    from risk_assessment import assess_risk
    result = assess_risk(opportunity_id)
"""

import os
import sys
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _db import run_sql, run_sql_one  # noqa: E402

# A requested discount above this is treated as a margin risk worth flagging.
DISCOUNT_RISK_THRESHOLD_PCT = 15


def assess_risk(opportunity_id: str) -> dict:
    risks = []

    # 1. Compliance / operational risk: constraints we can't (or might not) meet.
    compliance = run_sql(
        """
        SELECT ccr.result, ccr.severity, ccr.gap_description, cc.name AS constraint_name
        FROM constraint_compliance_results ccr
        JOIN tender_constraints tc ON tc.tender_constraint_id = ccr.tender_constraint_id
        LEFT JOIN constraint_catalog cc ON cc.constraint_type_id = tc.constraint_type_id
        WHERE ccr.opportunity_id = %s
          AND ccr.result IN ('unsatisfied', 'unclear_needs_verification')
        """,
        (opportunity_id,),
    )
    for c in compliance:
        risks.append({
            "category": "operational" if c["result"] == "unsatisfied" else "verification",
            "severity": c["severity"] or "medium",
            "title": (c["constraint_name"] or "Constraint") + (
                " cannot be satisfied" if c["result"] == "unsatisfied" else " needs verification"),
            "detail": c["gap_description"] or "",
        })

    # 2. Commercial risk: loss signals that are actually present.
    loss_signals = run_sql(
        """
        SELECT c.factor_name, c.strength
        FROM signal_check_results r
        JOIN win_loss_signal_catalog c ON c.signal_id = r.signal_id
        WHERE r.opportunity_id = %s AND r.status = 'present' AND c.direction = 'loss'
        ORDER BY c.strength DESC
        """,
        (opportunity_id,),
    )
    for s in loss_signals:
        risks.append({
            "category": "commercial",
            "severity": "high" if float(s["strength"]) >= 0.5 else "medium",
            "title": f"Loss signal present: {s['factor_name']}",
            "detail": f"Historical loss factor (strength {float(s['strength']):.2f}).",
        })

    # 3. Financial risk: aggressive requested discount + low-confidence fields.
    feats = run_sql_one(
        """
        SELECT requested_discount_pct, required_sla_hours, field_confidence
        FROM opportunity_features WHERE opportunity_id = %s
        """,
        (opportunity_id,),
    )
    if feats:
        discount = feats.get("requested_discount_pct")
        if discount is not None and float(discount) >= DISCOUNT_RISK_THRESHOLD_PCT:
            risks.append({
                "category": "financial",
                "severity": "high" if float(discount) >= 25 else "medium",
                "title": f"Aggressive requested discount ({float(discount):.0f}%)",
                "detail": "Margin pressure — validate against pricing guardrails.",
            })
        confidence = feats.get("field_confidence") or {}
        if isinstance(confidence, str):
            try:
                confidence = json.loads(confidence)
            except json.JSONDecodeError:
                confidence = {}
        low_conf = [k for k, v in confidence.items() if isinstance(v, (int, float)) and v < 0.5]
        if low_conf:
            risks.append({
                "category": "data_quality",
                "severity": "low",
                "title": "Low-confidence extracted fields",
                "detail": "Fields to double-check: " + ", ".join(low_conf),
            })

    order = {"high": 0, "medium": 1, "low": 2}
    risks.sort(key=lambda r: order.get(r["severity"], 3))

    counts = {"high": 0, "medium": 0, "low": 0}
    for r in risks:
        counts[r["severity"]] = counts.get(r["severity"], 0) + 1
    overall = "high" if counts["high"] else "medium" if counts["medium"] else "low" if counts["low"] else "none"

    return {
        "opportunity_id": opportunity_id,
        "overall_risk": overall,
        "risk_count": len(risks),
        "severity_counts": counts,
        "risks": risks,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python risk_assessment.py <opportunity_id>")
        sys.exit(1)
    print(json.dumps(assess_risk(sys.argv[1]), indent=2, default=str))
