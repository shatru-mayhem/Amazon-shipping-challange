"""sources_used — the evidence trail behind an opportunity's analysis:
every challenge document and email actually ingested for it, plus which
internal reference datasets (historical tenders, cost matrix, constraint
catalog/capability profile, pricing guardrails) the other skills draw
on for every opportunity, regardless of what's ingested. Pure read: no
writes, no Gemini — this only reports what already exists, it doesn't
decide what should have been used.

    from sources_used import list_sources_used
    result = list_sources_used(opportunity_id)
"""

import os
import sys
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _db import run_sql, run_sql_one  # noqa: E402


def list_sources_used(opportunity_id: str) -> dict:
    documents = run_sql(
        """SELECT document_id, filename, source_type, ingested_at
           FROM documents WHERE opportunity_id = %s ORDER BY ingested_at""",
        (opportunity_id,),
    )

    email_counts = run_sql_one(
        """SELECT count(DISTINCT et.thread_id) AS thread_count, count(em.message_id) AS message_count
           FROM email_threads et
           LEFT JOIN email_messages em ON em.thread_id = et.thread_id
           WHERE et.opportunity_id = %s""",
        (opportunity_id,),
    ) or {}

    tender_constraint_count = run_sql_one(
        "SELECT count(*) AS n FROM tender_constraints WHERE opportunity_id = %s",
        (opportunity_id,),
    ) or {}

    highlight_counts = run_sql(
        """SELECT source_type, count(*) AS n FROM client_highlights
           WHERE opportunity_id = %s GROUP BY source_type""",
        (opportunity_id,),
    )

    # Internal reference data every downstream skill draws on for every
    # opportunity — not opportunity-specific documents, but still part of
    # the evidence behind a recommendation (e.g. "why balanced pricing?"
    # traces to these rows, not to the tender document).
    historical_tenders = run_sql_one(
        "SELECT count(*) AS n, count(*) FILTER (WHERE outcome = 'won') AS won_n FROM historical_tenders"
    ) or {}
    cost_matrix_rows = run_sql_one("SELECT count(*) AS n FROM cost_matrix") or {}
    constraint_catalog_rows = run_sql_one("SELECT count(*) AS n FROM constraint_catalog WHERE active = TRUE") or {}
    capability_profile_rows = run_sql_one("SELECT count(*) AS n FROM amazon_capability_profile") or {}
    guardrails_row = run_sql_one(
        "SELECT effective_date FROM pricing_guardrails ORDER BY effective_date DESC LIMIT 1"
    )

    return {
        "opportunity_id": opportunity_id,
        "challenge_documents": [
            {
                "document_id": str(d["document_id"]),
                "filename": d["filename"],
                "source_type": d["source_type"],
                "ingested_at": d["ingested_at"],
            }
            for d in documents
        ],
        "email_correspondence": {
            "threads": email_counts.get("thread_count", 0) or 0,
            "messages": email_counts.get("message_count", 0) or 0,
        },
        "extracted_evidence": {
            "tender_constraints_extracted": tender_constraint_count.get("n", 0) or 0,
            "client_highlights_by_source": {h["source_type"]: h["n"] for h in highlight_counts},
        },
        "internal_reference_data": {
            "historical_tenders": {
                "total": historical_tenders.get("n", 0) or 0,
                "won": historical_tenders.get("won_n", 0) or 0,
                "used_by": ["pricing_recommendations", "win_probability", "opportunity_score"],
            },
            "cost_matrix_rows": {
                "total": cost_matrix_rows.get("n", 0) or 0,
                "used_by": ["pricing_recommendations"],
            },
            "constraint_catalog_active_entries": {
                "total": constraint_catalog_rows.get("n", 0) or 0,
                "used_by": ["retrieval (tender_constraints)", "risk_assessment"],
            },
            "amazon_capability_profile_rows": {
                "total": capability_profile_rows.get("n", 0) or 0,
                "used_by": ["risk_assessment (constraint_compliance_results)"],
            },
            "pricing_guardrails_effective_date": str(guardrails_row["effective_date"]) if guardrails_row else None,
        },
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python sources_used.py <opportunity_id>")
        sys.exit(1)
    print(json.dumps(list_sources_used(sys.argv[1]), indent=2, default=str))
