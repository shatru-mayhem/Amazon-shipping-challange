"""commercial_strategy — recommend positioning and a negotiation approach
for an opportunity from client highlights, win/loss signals, competitive
context, and known capability gaps. Pure read: no writes, no Gemini.

    from commercial_strategy import build_commercial_strategy
    result = build_commercial_strategy(opportunity_id)
"""

import os
import sys
import json

_SKILLS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _SKILLS_DIR)
sys.path.insert(0, os.path.join(_SKILLS_DIR, "constraint_compliance"))
from _db import run_sql, run_sql_one  # noqa: E402
from constraint_compliance import is_hard_blocker  # noqa: E402


def build_commercial_strategy(opportunity_id: str) -> dict:
    highlights = run_sql(
        """
        SELECT highlight_type, text
        FROM client_highlights
        WHERE opportunity_id = %s
        ORDER BY highlight_type
        """,
        (opportunity_id,),
    )
    by_type = {}
    for h in highlights:
        by_type.setdefault(h["highlight_type"], []).append(h["text"])

    signals = run_sql(
        """
        SELECT c.factor_name, c.direction, c.strength
        FROM signal_check_results r
        JOIN win_loss_signal_catalog c ON c.signal_id = r.signal_id
        WHERE r.opportunity_id = %s AND r.status = 'present'
        ORDER BY c.strength DESC
        """,
        (opportunity_id,),
    )
    strengths = [s["factor_name"] for s in signals if s["direction"] == "win"]
    objections = [s["factor_name"] for s in signals if s["direction"] == "loss"]

    proof_points = run_sql(
        """
        SELECT cc.name AS constraint_name
        FROM constraint_compliance_results ccr
        JOIN tender_constraints tc ON tc.tender_constraint_id = ccr.tender_constraint_id
        JOIN constraint_catalog cc ON cc.constraint_type_id = tc.constraint_type_id
        WHERE ccr.opportunity_id = %s AND ccr.result = 'satisfied'
        LIMIT 10
        """,
        (opportunity_id,),
    )

    # Client priorities are echoed as-is (never suppress stated client
    # intent), but a priority can silently conflict with a known
    # capability gap (e.g. "expand into France" vs. Delivery region
    # not_covered). Fuzzy-matching priority text against constraint
    # names is guessing; instead just surface every unsatisfied/unclear
    # constraint alongside the priorities so the contradiction is
    # visible in the output rather than staying silent about it.
    capability_gaps = run_sql(
        """
        SELECT cc.name AS constraint_name, ccr.result, ccr.severity, ccr.gap_description
        FROM constraint_compliance_results ccr
        JOIN tender_constraints tc ON tc.tender_constraint_id = ccr.tender_constraint_id
        LEFT JOIN constraint_catalog cc ON cc.constraint_type_id = tc.constraint_type_id
        WHERE ccr.opportunity_id = %s
          AND ccr.result IN ('unsatisfied', 'unclear_needs_verification')
        """,
        (opportunity_id,),
    )

    ctx = run_sql_one(
        """
        SELECT of.incumbent_provider, of.requested_discount_pct, o.title
        FROM opportunities o
        LEFT JOIN opportunity_features of ON of.opportunity_id = o.opportunity_id
        WHERE o.opportunity_id = %s
        """,
        (opportunity_id,),
    ) or {}

    pains = by_type.get("pain_point", []) + by_type.get("past_complaint", [])
    priorities = by_type.get("stated_priority", []) + by_type.get("growth_objective", [])

    positioning = _positioning(ctx, priorities, strengths, capability_gaps)
    negotiation = _negotiation(ctx, objections)

    return {
        "opportunity_id": opportunity_id,
        "title": ctx.get("title"),
        "positioning_statement": positioning,
        "lead_with_strengths": strengths[:5],
        "proof_points": [p["constraint_name"] for p in proof_points],
        "address_client_pains": pains[:5],
        "align_to_priorities": priorities[:5],
        "capability_gaps_to_flag": [
            {
                "constraint_name": g["constraint_name"],
                "result": g["result"],
                "severity": g["severity"],
                "gap_description": g["gap_description"],
                # unsatisfied == a hard rule Amazon cannot change (not just
                # unverified) — same is_hard_blocker used by risk_assessment,
                # applied identically regardless of which constraint type.
                "is_hard_blocker": is_hard_blocker(g["result"]),
            }
            for g in capability_gaps
        ],
        "has_hard_blocker": any(is_hard_blocker(g["result"]) for g in capability_gaps),
        "objections_to_preempt": objections[:5],
        "negotiation_approach": negotiation,
        "incumbent_provider": ctx.get("incumbent_provider"),
    }


_STOPWORDS = {
    "the", "and", "that", "this", "with", "from", "into", "for", "are", "was",
    "have", "has", "not", "but", "they", "their", "them", "will", "would",
    "can", "could", "should", "need", "needs", "want", "wants", "just", "only",
    "also", "than", "then", "what", "when", "where", "which", "who", "whom",
}


def _keywords(text: str) -> set:
    return {w for w in "".join(c.lower() if c.isalnum() else " " for c in text).split()
            if len(w) >= 4 and w not in _STOPWORDS}


def _conflicts_with_hard_blocker(priority: str, hard_blocker_gaps: list) -> bool:
    """Deliberately simple keyword overlap, not NLP — same "don't guess
    precisely, just don't stay silent" tradeoff as constraint_compliance's
    term matching. False positives here just mean picking a different,
    still-true priority to anchor on; false negatives are the actual
    risk (a blocked priority slipping into client-facing positioning
    text), so this errs toward over-flagging, not under-flagging."""
    priority_words = _keywords(priority)
    for gap in hard_blocker_gaps:
        gap_words = _keywords(gap.get("gap_description") or "") | _keywords(gap.get("constraint_name") or "")
        if priority_words & gap_words:
            return True
    return False


def _positioning(ctx: dict, priorities: list, strengths: list, capability_gaps: list) -> str:
    incumbent = ctx.get("incumbent_provider")
    lead = strengths[0].replace("_", " ") if strengths else "reliability and network scale"

    hard_blocker_gaps = [g for g in capability_gaps if is_hard_blocker(g.get("result"))]

    # Never anchor client-facing positioning on a priority that overlaps a
    # known hard capability blocker — e.g. don't position around "expand
    # into France" when Delivery region compliance already says France
    # isn't covered. Pick the first priority that doesn't conflict instead.
    safe_priorities = [p for p in priorities if not _conflicts_with_hard_blocker(p, hard_blocker_gaps)]
    prio = safe_priorities[0] if safe_priorities else "their stated operational goals"

    # This string is client-facing (client_proposal.py puts it directly in
    # sections.why_amazon_shipping.positioning) — it must never contain
    # internal-only warnings. Those live in capability_gaps_to_flag /
    # has_hard_blocker instead, which client_proposal.py deliberately
    # keeps out of `sections` (see its internal_flags field).
    base = f"Position Amazon Shipping around {lead}, directly tied to {prio}."
    if incumbent:
        base += f" Frame against the incumbent ({incumbent}) on service consistency and coverage."
    return base


def _negotiation(ctx: dict, objections: list) -> str:
    discount = ctx.get("requested_discount_pct")
    parts = []
    if discount is not None and float(discount) > 0:
        parts.append(
            f"Client asked for {float(discount):.0f}% off — trade any concession for term length "
            f"or volume commitment rather than giving flat discount."
        )
    else:
        parts.append("No explicit discount ask — anchor on value, hold list pricing.")
    if objections:
        parts.append("Pre-empt likely objections: " + ", ".join(objections[:3]) + ".")
    return " ".join(parts)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python commercial_strategy.py <opportunity_id>")
        sys.exit(1)
    print(json.dumps(build_commercial_strategy(sys.argv[1]), indent=2, default=str))
