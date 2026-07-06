"""persist — writes retrieval.py's answers into the structured tables the
8 downstream skills (risk_assessment, commercial_strategy,
pricing_recommendations, follow_up_actions, opportunity_score,
win_probability, client_proposal, executive_summary) actually read.

None of those 8 skills touch an LLM at all — they're pure SQL/Python over
opportunity_features, tender_constraints, client_highlights,
signal_check_results, constraint_compliance_results, etc. retrieve()
already does 100% of the LLM/FAISS work and returns a correct answer; the
only thing missing was committing that answer somewhere. This is that
one missing piece — run once per opportunity, after which every
downstream skill is instant (pure SQL) with zero further LLM calls for
that opportunity, forever (until new source documents arrive).

    from persist import persist_opportunity
    result = persist_opportunity(opportunity_id)

Writes via the app_ingestion role (skills/_ingestion_db.py) — the same
one tender_ingestion.ts already uses. Idempotent: safe to re-run after
new documents/emails are ingested (tender_constraints and
client_highlights are replaced wholesale each run; opportunity_features
is upserted per-field, keeping any previously-found value a re-run
doesn't overwrite with a fresh not_found).
"""

import os
import sys
from psycopg2.extras import Json

_SKILLS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SKILLS_DIR not in sys.path:
    sys.path.insert(0, _SKILLS_DIR)
sys.path.insert(0, os.path.join(_SKILLS_DIR, "constraint_compliance"))
sys.path.insert(0, os.path.join(_SKILLS_DIR, "win_loss_signals"))

from _db import run_sql  # noqa: E402
from _ingestion_db import write_sql  # noqa: E402
from retrieval import retrieve, OPPORTUNITY_FEATURE_SPECS  # noqa: E402
from constraint_compliance import persist_compliance  # noqa: E402
from win_loss_signals import persist_signals  # noqa: E402


def _num(v):
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def _int(v):
    try:
        return None if v is None else int(float(v))
    except (TypeError, ValueError):
        return None


def _str(v):
    return None if v is None else str(v)


def _persist_opportunity_features(opportunity_id: str) -> dict:
    values, confidence = {}, {}
    for field in OPPORTUNITY_FEATURE_SPECS:
        result = retrieve(opportunity_id, "opportunity_features", field)
        if result["status"] == "found":
            values[field] = result["value"]
            if result.get("confidence") is not None:
                confidence[field] = result["confidence"]

    if not values:
        return {"fields_written": 0}

    geography = values.get("geography")
    lanes = values.get("lanes")

    write_sql(
        """INSERT INTO opportunity_features
             (opportunity_id, volume, lanes, geography, industry_vertical,
              contract_length_months, required_sla_hours, incumbent_provider,
              requested_discount_pct, field_confidence)
           VALUES (%(opportunity_id)s, %(volume)s, %(lanes)s, %(geography)s, %(industry_vertical)s,
                   %(contract_length_months)s, %(required_sla_hours)s, %(incumbent_provider)s,
                   %(requested_discount_pct)s, %(field_confidence)s)
           ON CONFLICT (opportunity_id) DO UPDATE SET
             volume                  = COALESCE(EXCLUDED.volume, opportunity_features.volume),
             lanes                   = COALESCE(EXCLUDED.lanes, opportunity_features.lanes),
             geography               = COALESCE(EXCLUDED.geography, opportunity_features.geography),
             industry_vertical       = COALESCE(EXCLUDED.industry_vertical, opportunity_features.industry_vertical),
             contract_length_months  = COALESCE(EXCLUDED.contract_length_months, opportunity_features.contract_length_months),
             required_sla_hours      = COALESCE(EXCLUDED.required_sla_hours, opportunity_features.required_sla_hours),
             incumbent_provider      = COALESCE(EXCLUDED.incumbent_provider, opportunity_features.incumbent_provider),
             requested_discount_pct  = COALESCE(EXCLUDED.requested_discount_pct, opportunity_features.requested_discount_pct),
             field_confidence        = opportunity_features.field_confidence || EXCLUDED.field_confidence,
             extracted_at            = now()""",
        {
            "opportunity_id": opportunity_id,
            "volume": _num(values.get("volume")),
            "lanes": Json(lanes) if lanes is not None else None,
            "geography": geography if isinstance(geography, list) else None,
            "industry_vertical": _str(values.get("industry_vertical")),
            "contract_length_months": _int(values.get("contract_length_months")),
            "required_sla_hours": _num(values.get("required_sla_hours")),
            "incumbent_provider": _str(values.get("incumbent_provider")),
            "requested_discount_pct": _num(values.get("requested_discount_pct")),
            "field_confidence": Json(confidence),
        },
    )
    return {"fields_written": len(values)}


def _persist_tender_constraints(opportunity_id: str) -> dict:
    result = retrieve(opportunity_id, "tender_constraints")
    # constraint_compliance_results FK-references tender_constraints and is
    # always rebuilt wholesale right after this step anyway, so clear it
    # first — otherwise a re-run's delete below hits a FK violation from
    # the previous run's compliance rows still pointing at these ids.
    write_sql("DELETE FROM constraint_compliance_results WHERE opportunity_id = %s", (opportunity_id,))
    write_sql("DELETE FROM tender_constraints WHERE opportunity_id = %s", (opportunity_id,))
    if result["status"] != "found":
        return {"rows_written": 0}

    matched = result["value"]["matched"]
    if not matched:
        return {"rows_written": 0}

    chunk_ids = {cid for m in matched for cid in m["source_chunk_ids"]}
    chunk_rows = run_sql(
        "SELECT chunk_id, document_id FROM document_chunks WHERE chunk_id = ANY(%s::uuid[])",
        (list(chunk_ids),),
    )
    chunk_to_doc = {str(r["chunk_id"]): str(r["document_id"]) for r in chunk_rows}

    written = 0
    for m in matched:
        first_chunk_id = str(m["source_chunk_ids"][0])
        document_id = chunk_to_doc.get(first_chunk_id)
        if not document_id:
            continue  # shouldn't happen — don't let one bad row block the rest
        write_sql(
            """INSERT INTO tender_constraints
                 (opportunity_id, constraint_type_id, stated_value, stated_text,
                  source_document_id, source_chunk_id, confidence_score)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (
                opportunity_id,
                m["matched_constraint_type_id"],
                Json({"value": m["stated_value"]}) if m["stated_value"] is not None else None,
                m["stated_text"],
                document_id,
                first_chunk_id,
                min(max(m["relevance_score"], 0.0), 1.0),
            ),
        )
        written += 1
    return {"rows_written": written}


def _persist_client_highlights(opportunity_id: str) -> dict:
    result = retrieve(opportunity_id, "client_highlights")
    write_sql("DELETE FROM client_highlights WHERE opportunity_id = %s", (opportunity_id,))
    if result["status"] != "found":
        return {"rows_written": 0}

    highlights = result["value"]
    for h in highlights:
        # retrieval.py batches snippets per source_type before extracting,
        # so a highlight's provenance is source_ids (plural, the whole
        # batch) — client_highlights.source_id is singular, so use the
        # first one. Same tradeoff already documented in retrieval.py's
        # tender_constraints (source_chunk_ids -> first chunk_id).
        source_id = h["source_ids"][0] if h.get("source_ids") else None
        if not source_id:
            continue
        write_sql(
            """INSERT INTO client_highlights (opportunity_id, highlight_type, text, source_type, source_id)
               VALUES (%s, %s, %s, %s, %s)""",
            (opportunity_id, h["highlight_type"], h["text"], h["source_type"], source_id),
        )
    return {"rows_written": len(highlights)}


def _persist_email_resolutions(opportunity_id: str) -> dict:
    result = retrieve(opportunity_id, "email_messages")
    if result["status"] != "found":
        return {"rows_updated": 0}

    resolutions = result["value"]
    for r in resolutions:
        write_sql("UPDATE email_messages SET resolved = TRUE WHERE message_id = %s", (r["message_id"],))
    return {"rows_updated": len(resolutions)}


def _persist_constraint_compliance(opportunity_id: str) -> dict:
    return persist_compliance(opportunity_id)


def _persist_win_loss_signals(opportunity_id: str) -> dict:
    return persist_signals(opportunity_id)


def persist_opportunity(opportunity_id: str) -> dict:
    tender_constraints = _persist_tender_constraints(opportunity_id)
    constraint_compliance = _persist_constraint_compliance(opportunity_id)
    return {
        "opportunity_id": opportunity_id,
        "opportunity_features": _persist_opportunity_features(opportunity_id),
        "tender_constraints": tender_constraints,
        # depends on tender_constraints already being written this run
        "constraint_compliance": constraint_compliance,
        # depends on constraint_compliance already being written this run
        "win_loss_signals": _persist_win_loss_signals(opportunity_id),
        "client_highlights": _persist_client_highlights(opportunity_id),
        "email_messages": _persist_email_resolutions(opportunity_id),
    }


if __name__ == "__main__":
    import json

    if len(sys.argv) < 2:
        print("Usage: python persist.py <opportunity_id>")
        sys.exit(1)

    print(json.dumps(persist_opportunity(sys.argv[1]), indent=2, default=str))
