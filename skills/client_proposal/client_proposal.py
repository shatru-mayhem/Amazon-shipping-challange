"""client_proposal — assemble the client-facing proposal / pitch deck
sections for an opportunity. Composes commercial_strategy and
pricing_recommendations and pulls client highlights + proof points from the
DB. Pure read: no writes, no Gemini (it produces structured deck content
that a rendering layer or an LLM can later turn into slides).

    from client_proposal import build_client_proposal
    result = build_client_proposal(opportunity_id)
"""

import os
import sys
import json

_SKILLS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _SKILLS_DIR)
sys.path.insert(0, os.path.join(_SKILLS_DIR, "commercial_strategy"))
sys.path.insert(0, os.path.join(_SKILLS_DIR, "pricing_recommendations"))

from _db import run_sql, run_sql_one  # noqa: E402
from commercial_strategy import build_commercial_strategy  # noqa: E402
from pricing_recommendations import recommend_pricing  # noqa: E402


def build_client_proposal(opportunity_id: str, selected_scenario: str = None) -> dict:
    opp = run_sql_one(
        """
        SELECT o.title, c.name AS customer_name, c.industry, c.region
        FROM opportunities o
        JOIN customers c ON c.customer_id = o.customer_id
        WHERE o.opportunity_id = %s
        """,
        (opportunity_id,),
    ) or {}

    highlights = run_sql(
        "SELECT highlight_type, text FROM client_highlights WHERE opportunity_id = %s",
        (opportunity_id,),
    )
    needs = [h["text"] for h in highlights
             if h["highlight_type"] in ("pain_point", "stated_priority", "growth_objective")]

    strategy = build_commercial_strategy(opportunity_id)
    pricing = recommend_pricing(opportunity_id)

    chosen = selected_scenario or pricing.get("recommended_scenario", "balanced")
    chosen_scenario = next(
        (s for s in pricing.get("scenarios", []) if s["name"] == chosen), None
    )

    sections = {
        "cover": {
            "title": f"Proposal for {opp.get('customer_name', 'Client')}",
            "subtitle": opp.get("title", ""),
            "prepared_for": opp.get("customer_name"),
            "industry": opp.get("industry"),
            "region": opp.get("region"),
        },
        "understanding_your_needs": {
            "headline": "What we heard from you",
            "points": needs[:6] or ["(no client highlights captured yet)"],
        },
        "why_amazon_shipping": {
            "headline": "Why Amazon Shipping",
            "differentiators": strategy.get("lead_with_strengths", []),
            "proof_points": strategy.get("proof_points", []),
            "positioning": strategy.get("positioning_statement"),
        },
        "commercial_proposal": {
            "headline": "Commercial proposal",
            "selected_scenario": chosen,
            "scenario": chosen_scenario,
            "all_scenarios": pricing.get("scenarios", []),
        },
        "next_steps": {
            "headline": "Recommended next steps",
            "points": [
                "Confirm scope and volumes",
                "Align on SLA and coverage",
                strategy.get("negotiation_approach", "Agree commercial terms"),
            ],
        },
    }

    return {
        "opportunity_id": opportunity_id,
        "customer": opp.get("customer_name"),
        "selected_scenario": chosen,
        "sections": sections,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python client_proposal.py <opportunity_id> [scenario]")
        sys.exit(1)
    scenario = sys.argv[2] if len(sys.argv) > 2 else None
    print(json.dumps(build_client_proposal(sys.argv[1], scenario), indent=2, default=str))
